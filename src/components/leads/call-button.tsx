"use client";

import { useState, useTransition } from "react";
import { Copy, Loader2, Phone, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { CALL_OUTCOMES, type CallOutcome } from "@/lib/library";
import { cn } from "@/lib/utils";
import { logCall, setCallOutcome } from "@/server/actions/calls";

const DIAL_WAIT_MS = 1200;

/** A computer with a mouse can't dial: it shows a QR code for the phone instead. */
const isDesktop = () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/**
 * Starts a call: logs it in the lead's timeline, then opens the phone dialer
 * (phones) or a QR code to scan with a phone (desktop). Dialing never waits
 * more than ~1 s for the log to be saved.
 */
export function useLeadCall(leadId: string, phone: string, onLogged?: () => void) {
  const [starting, setStarting] = useState(false);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);

  async function start() {
    if (starting) return;
    setStarting(true);
    const logging = logCall({ leadId });
    if (isDesktop()) setQrOpen(true);
    else {
      await Promise.race([logging, new Promise((r) => setTimeout(r, DIAL_WAIT_MS))]);
      window.location.href = `tel:${phone}`;
    }
    const r = await logging;
    setStarting(false);
    if (!r.ok) { toast.error(`Call not logged: ${r.error}`); return; }
    onLogged?.();
    setActivityId(r.data.activityId);
  }

  return { start, starting, activityId, qrOpen, closeQr: () => setQrOpen(false), reset: () => { setActivityId(null); setQrOpen(false); } };
}

export function CallButton({ leadId, phone, leadName, onLogged, className, size }: {
  leadId: string; phone: string; leadName: string; onLogged?: () => void; className?: string; size?: "default" | "sm";
}) {
  const call = useLeadCall(leadId, phone, onLogged);
  return (
    <>
      <Button size={size} className={className} onClick={() => void call.start()} disabled={call.starting}>
        {call.starting ? <Loader2 className="animate-spin" /> : <Phone />} Call
      </Button>
      <CallQrDialog open={call.qrOpen} onClose={call.closeQr} phone={phone} leadName={leadName} />
      {/* On desktop the outcome is asked once the QR code is closed. */}
      <CallOutcomeDialog activityId={call.qrOpen ? null : call.activityId} leadName={leadName} onClose={call.reset} onSaved={onLogged} />
    </>
  );
}

/** Centered QR code that opens the phone's dialer with this number. */
export function CallQrDialog({ open, onClose, phone, leadName }: { open: boolean; onClose: () => void; phone: string; leadName: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(phone);
      toast.success("Number copied");
    } catch {
      toast.error("Couldn't copy the number.");
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader className="items-center text-center">
          <DialogTitle>Call {leadName}</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <Smartphone className="size-4" /> Scan with your phone&apos;s camera to dial.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-xl bg-white p-4">
            <QRCodeSVG value={`tel:${phone}`} size={208} marginSize={0} aria-label={`QR code to call ${phone}`} />
          </div>
          <p className="text-lg font-semibold tracking-wide tabular-nums">{phone}</p>
          <p className="text-center text-xs text-muted-foreground">The call is already logged in the timeline.</p>
        </div>
        <DialogFooter className="sm:justify-center">
          <Button variant="outline" onClick={() => void copy()}><Copy /> Copy number</Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Outcome buttons shared by the call dialog and the follow-up completion dialog. */
export function CallOutcomePicker({ value, onChange }: { value: CallOutcome | null; onChange: (o: CallOutcome) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Call outcome">
      {(Object.keys(CALL_OUTCOMES) as CallOutcome[]).map((o) => (
        <Button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          variant="outline"
          className={cn(value === o && "border-primary bg-white/[0.1]")}
          onClick={() => onChange(o)}
        >
          {CALL_OUTCOMES[o]}
        </Button>
      ))}
    </div>
  );
}

function CallOutcomeDialog({ activityId, leadName, onClose, onSaved }: { activityId: string | null; leadName: string; onClose: () => void; onSaved?: () => void }) {
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (shownFor !== activityId) {
    setShownFor(activityId);
    if (activityId) { setOutcome(null); setNote(""); }
  }

  const save = () => {
    if (!activityId || !outcome) return;
    start(async () => {
      const r = await setCallOutcome({ activityId, outcome, note: note.trim() || undefined });
      if (!r.ok) return void toast.error(r.fieldErrors?.note?.[0] ?? r.error);
      toast.success("Call outcome saved");
      onSaved?.();
      onClose();
    });
  };

  return (
    <Dialog open={!!activityId} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>How did the call go?</DialogTitle>
          <DialogDescription>The call to {leadName} is already in the timeline. Add the result so the team knows what happened.</DialogDescription>
        </DialogHeader>
        <CallOutcomePicker value={outcome} onChange={setOutcome} />
        <Field>
          <FieldLabel htmlFor="call-note">Note (optional)</FieldLabel>
          <Textarea id="call-note" rows={3} maxLength={1000} placeholder="e.g. Asked to call back after 6 pm" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Skip</Button>
          <Button onClick={save} disabled={pending || !outcome}>{pending && <Loader2 className="animate-spin" />}Save outcome</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
