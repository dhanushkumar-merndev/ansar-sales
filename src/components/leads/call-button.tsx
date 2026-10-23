"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Copy, Loader2, MessageCircle, Phone, Smartphone, Timer } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { CallNotes } from "@/components/leads/call-notes";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { CALL_OUTCOMES, whatsappUrl, type CallOutcome } from "@/lib/library";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";
import { logCall, setCallDuration, setCallOutcome } from "@/server/actions/calls";

const DIAL_WAIT_MS = 1200;

/** A computer with a mouse can't dial: it shows a QR code for the phone instead. */
const isDesktop = () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/**
 * Starts a call: logs it in the lead's timeline, then opens the phone dialer
 * (phones) or a QR code to scan with a phone (desktop). Dialing never waits
 * more than ~1 s for the log to be saved.
 *
 * Talk time runs from pressing Call until Done on the QR code (desktop) or until
 * the person comes back to the app after dialing (phone); it is saved on the call.
 */
export function useLeadCall(leadId: string, phone: string, onLogged?: () => void) {
  const [starting, setStarting] = useState(false);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [dialing, setDialing] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const startedAt = useRef<number | null>(null);
  const logged = useRef<Promise<string | null> | null>(null);

  async function stop() {
    if (startedAt.current === null) return;
    const seconds = Math.round((Date.now() - startedAt.current) / 1000);
    startedAt.current = null;
    setDurationSeconds(seconds);
    const id = await logged.current;
    if (!id) return;
    const r = await setCallDuration({ activityId: id, seconds });
    if (!r.ok) toast.error(`Talk time not saved: ${r.error}`);
    else onLogged?.();
  }
  const stopRef = useRef(stop);
  useEffect(() => { stopRef.current = stop; });

  // On a phone the dialer takes over the screen; the call is over when the app is visible again.
  useEffect(() => {
    if (!dialing) return;
    let left = document.visibilityState === "hidden";
    const onChange = () => {
      if (document.visibilityState === "hidden") left = true;
      else if (left) { setDialing(false); void stopRef.current(); }
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [dialing]);

  async function start() {
    if (starting) return;
    setStarting(true);
    setDurationSeconds(null);
    startedAt.current = Date.now();
    const logging = logCall({ leadId });
    logged.current = logging.then((r) => (r.ok ? r.data.activityId : null));
    if (isDesktop()) setQrOpen(true);
    else {
      setDialing(true);
      await Promise.race([logging, new Promise((r) => setTimeout(r, DIAL_WAIT_MS))]);
      window.location.href = `tel:${phone}`;
    }
    const r = await logging;
    setStarting(false);
    if (!r.ok) { startedAt.current = null; setDialing(false); toast.error(`Call not logged: ${r.error}`); return; }
    onLogged?.();
    setActivityId(r.data.activityId);
  }

  return {
    start, starting, activityId, qrOpen, durationSeconds,
    closeQr: () => { setQrOpen(false); void stop(); },
    reset: () => { setActivityId(null); setQrOpen(false); setDialing(false); setDurationSeconds(null); startedAt.current = null; },
  };
}

export function CallButton({ leadId, phone, leadName, onLogged, className, size, variant, iconOnly }: {
  leadId: string; phone: string; leadName: string; onLogged?: () => void; className?: string;
  size?: "default" | "sm" | "icon-sm"; variant?: "default" | "outline" | "ghost"; iconOnly?: boolean;
}) {
  const call = useLeadCall(leadId, phone, onLogged);
  return (
    <>
      <Button size={size} variant={variant} className={className} onClick={() => void call.start()} disabled={call.starting} aria-label={iconOnly ? `Call ${leadName}` : undefined}>
        {call.starting ? <Loader2 className="animate-spin" /> : <Phone />}{iconOnly ? null : " Call"}
      </Button>
      <CallQrDialog open={call.qrOpen} onClose={call.closeQr} leadId={leadId} phone={phone} leadName={leadName} />
      {/* On desktop the outcome is asked once the QR code is closed. */}
      <CallOutcomeDialog activityId={call.qrOpen ? null : call.activityId} durationSeconds={call.durationSeconds} leadName={leadName} onClose={call.reset} onSaved={onLogged} />
    </>
  );
}

/** Opens a WhatsApp chat with the number (the app on phones, WhatsApp Web/desktop otherwise). */
export function WhatsAppButton({ phone, className, size }: { phone: string; className?: string; size?: "default" | "sm" }) {
  return (
    <Button asChild variant="outline" size={size} className={className}>
      <a href={whatsappUrl(phone)} target="_blank" rel="noopener noreferrer"><MessageCircle /> WhatsApp</a>
    </Button>
  );
}

/**
 * Centered QR code that opens the phone's dialer with this number, beside the lead's earlier notes.
 * Done closes it; X, Esc or a click outside ask first, so it isn't lost mid-call by accident.
 */
export function CallQrDialog({ open, onClose, leadId, phone, leadName }: { open: boolean; onClose: () => void; leadId: string; phone: string; leadName: string }) {
  const [confirmClose, setConfirmClose] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(phone);
      toast.success("Number copied");
    } catch {
      toast.error("Couldn't copy the number.");
    }
  };
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && setConfirmClose(true)}>
        {/* Full screen: the notes get the whole height beside the QR code. */}
        <DialogContent className="flex h-[calc(100svh-2rem)] flex-col sm:max-w-[calc(100%-2rem)]">
          <DialogHeader className="items-center text-center">
            <DialogTitle>Call {leadName}</DialogTitle>
            <DialogDescription className="flex items-center gap-1.5">
              <Smartphone className="size-4" /> Scan with your phone&apos;s camera to dial.
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto sm:grid-cols-[auto_minmax(0,1fr)] sm:overflow-hidden">
            <div className="flex flex-col items-center gap-3 sm:justify-center sm:px-6">
              <div className="rounded-xl bg-white p-4">
                <QRCodeSVG value={`tel:${phone}`} size={208} marginSize={0} aria-label={`QR code to call ${phone}`} />
              </div>
              <p className="text-lg font-semibold tracking-wide tabular-nums">{phone}</p>
              <p className="text-center text-xs text-muted-foreground">The call is already logged in the timeline.</p>
            </div>
            {open ? <CallNotes leadId={leadId} className="sm:border-l sm:pl-6" /> : null}
          </div>
          <DialogFooter className="sm:justify-center">
            <Button variant="outline" onClick={() => void copy()}><Copy /> Copy number</Button>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={open && confirmClose}
        onOpenChange={setConfirmClose}
        title="Close the call screen?"
        description="The call is already logged. You'll be asked how it went next."
        confirmLabel="Close"
        onConfirm={async () => onClose()}
      />
    </>
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

function CallOutcomeDialog({ activityId, durationSeconds, leadName, onClose, onSaved }: {
  activityId: string | null; durationSeconds: number | null; leadName: string; onClose: () => void; onSaved?: () => void;
}) {
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
        {/* Measured, not typed: it can be corrected later from the timeline ("Edit talk time"). */}
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Timer className="size-3.5" aria-hidden /> Talk time
          <span className="font-medium text-foreground">{durationSeconds === null ? "—" : formatDuration(durationSeconds)}</span>
        </p>
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
