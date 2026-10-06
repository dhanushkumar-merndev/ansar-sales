"use client";

import { useState, useTransition } from "react";
import { Loader2, Phone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { CALL_OUTCOMES, type CallOutcome } from "@/lib/library";
import { cn } from "@/lib/utils";
import { logCall, setCallOutcome } from "@/server/actions/calls";

const DIAL_WAIT_MS = 1200;

/**
 * Logs the call in the timeline, opens the phone dialer, then asks how it went.
 * Dialing never waits more than ~1 s for the log to be saved.
 */
export function CallButton({ leadId, phone, leadName, onLogged, className, size }: {
  leadId: string; phone: string; leadName: string; onLogged?: () => void; className?: string; size?: "default" | "sm";
}) {
  const [starting, setStarting] = useState(false);
  const [activityId, setActivityId] = useState<string | null>(null);

  async function call() {
    if (starting) return;
    setStarting(true);
    const logging = logCall({ leadId });
    await Promise.race([logging, new Promise((r) => setTimeout(r, DIAL_WAIT_MS))]);
    window.location.href = `tel:${phone}`;
    const r = await logging;
    setStarting(false);
    if (!r.ok) { toast.error(`Call not logged: ${r.error}`); return; }
    onLogged?.();
    setActivityId(r.data.activityId);
  }

  return (
    <>
      <Button size={size} className={className} onClick={() => void call()} disabled={starting}>
        {starting ? <Loader2 className="animate-spin" /> : <Phone />} Call
      </Button>
      <CallOutcomeDialog activityId={activityId} leadName={leadName} onClose={() => setActivityId(null)} onSaved={onLogged} />
    </>
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
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Call outcome">
          {(Object.keys(CALL_OUTCOMES) as CallOutcome[]).map((o) => (
            <Button
              key={o}
              type="button"
              role="radio"
              aria-checked={outcome === o}
              variant="outline"
              className={cn(outcome === o && "border-primary bg-white/[0.1]")}
              onClick={() => setOutcome(o)}
            >
              {CALL_OUTCOMES[o]}
            </Button>
          ))}
        </div>
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
