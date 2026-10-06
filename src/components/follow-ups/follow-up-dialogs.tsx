"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Loader2, Phone } from "lucide-react";
import { toast } from "sonner";
import { DateTimeField, type IstDateTime } from "@/components/common/date-time-field";
import { CallOutcomePicker, CallQrDialog, useLeadCall } from "@/components/leads/call-button";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CallOutcome } from "@/lib/library";
import { addDays, istToUtcIso, istToday, utcToIstParts } from "@/lib/time";
import { setCallOutcome } from "@/server/actions/calls";
import { completeFollowUp, rescheduleFollowUp, scheduleFollowUp } from "@/server/actions/follow-ups";

function toUtc(v: IstDateTime): string | null {
  try {
    return istToUtcIso(v.date, v.time);
  } catch {
    return null;
  }
}

/** Schedule a new follow-up (leadId) or reschedule an existing one (followUp). */
export function FollowUpDialog({
  open, onOpenChange, leadId, followUp, onDone,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; leadId?: string;
  followUp?: { id: string; task: string; due_at: string }; onDone?: () => void;
}) {
  const [task, setTask] = useState("");
  const [when, setWhen] = useState<IstDateTime>({ date: "", time: "" });
  const [pending, start] = useTransition();

  const [openedFor, setOpenedFor] = useState<{ open: boolean; followUp?: { id: string } }>({ open: false });
  if (openedFor.open !== open || openedFor.followUp !== followUp) {
    setOpenedFor({ open, followUp });
    if (open) {
      setTask(followUp?.task ?? "");
      setWhen(followUp ? utcToIstParts(followUp.due_at) : { date: addDays(istToday(), 1), time: "10:00" });
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const dueAt = toUtc(when);
    if (!task.trim()) return void toast.error("Describe the task.");
    if (!dueAt) return void toast.error("Pick a valid date and time.");
    if (new Date(dueAt).getTime() < Date.now() - 5 * 60_000) return void toast.error("Choose a time in the future.");
    start(async () => {
      const r = followUp ? await rescheduleFollowUp({ id: followUp.id, task, dueAt }) : await scheduleFollowUp({ leadId, task, dueAt });
      if (!r.ok) return void toast.error(r.error);
      toast.success(followUp ? "Follow-up rescheduled" : "Follow-up scheduled");
      onOpenChange(false);
      onDone?.();
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{followUp ? "Reschedule follow-up" : "Schedule follow-up"}</DialogTitle>
          <DialogDescription>Times are in India Standard Time (IST). A Telegram reminder is sent at the due time.</DialogDescription>
        </DialogHeader>
        <form id="fu-form" onSubmit={submit} noValidate>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="fu-task">Task</FieldLabel>
              <Input id="fu-task" value={task} maxLength={500} onChange={(e) => setTask(e.target.value)} placeholder="Call to discuss pricing" />
            </Field>
            <Field>
              <FieldLabel htmlFor="fu-date">Due</FieldLabel>
              <DateTimeField idPrefix="fu" value={when} onChange={setWhen} />
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button type="submit" form="fu-form" disabled={pending}>{pending && <Loader2 className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The lead's number for the Call button (normalized, no spaces). */
type CallableLead = { id: string; name: string; phone: string };

export function CompleteFollowUpDialog({
  open, onOpenChange, followUp, lead, onDone,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; followUp: { id: string; task: string } | null;
  /** When given, the dialog offers a Call button and saves how the call went together with the completion. */
  lead?: CallableLead | null; onDone?: () => void;
}) {
  // Remounted per follow-up so a call made for one task never carries over to the next.
  return (
    <Dialog open={open} onOpenChange={(o) => onOpenChange(o)}>
      {open && followUp ? <CompleteFollowUpContent key={followUp.id} followUp={followUp} lead={lead ?? null} onOpenChange={onOpenChange} onDone={onDone} /> : null}
    </Dialog>
  );
}

function CompleteFollowUpContent({
  followUp, lead, onOpenChange, onDone,
}: { followUp: { id: string; task: string }; lead: CallableLead | null; onOpenChange: (o: boolean) => void; onDone?: () => void }) {
  const [outcome, setOutcome] = useState("");
  const [scheduleNext, setScheduleNext] = useState(false);
  const [nextTask, setNextTask] = useState("");
  const [when, setWhen] = useState<IstDateTime>(() => ({ date: addDays(istToday(), 2), time: "10:00" }));
  const [pending, start] = useTransition();
  const call = useLeadCall(lead?.id ?? "", lead?.phone ?? "");
  const [callResult, setCallResult] = useState<CallOutcome | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (call.activityId && !callResult) return void toast.error("Choose how the call went.");
    let nextDueAt: string | undefined;
    if (scheduleNext) {
      nextDueAt = toUtc(when) ?? undefined;
      if (!nextDueAt) return void toast.error("Pick a valid date and time for the next follow-up.");
    }
    start(async () => {
      // The call is already in the timeline; its result and the notes are saved with the completion.
      if (call.activityId && callResult) {
        const c = await setCallOutcome({ activityId: call.activityId, outcome: callResult, note: outcome.trim() || undefined });
        if (!c.ok) return void toast.error(c.fieldErrors?.note?.[0] ?? c.error);
      }
      const r = await completeFollowUp({ id: followUp.id, outcome, nextDueAt, nextTask: scheduleNext ? nextTask : undefined });
      if (!r.ok) return void toast.error(r.error);
      toast.success(call.activityId ? "Call saved and follow-up completed" : "Follow-up completed");
      onOpenChange(false);
      onDone?.();
    });
  };

  return (
    <>
      <DialogContent className="sm:max-w-md" onInteractOutside={(e) => pending && e.preventDefault()} onEscapeKeyDown={(e) => pending && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Complete follow-up</DialogTitle>
          <DialogDescription className="line-clamp-2">{followUp.task}</DialogDescription>
        </DialogHeader>
        <form id="fu-complete" onSubmit={submit} noValidate>
          <FieldGroup className="gap-4">
            {lead ? (
              <div className="space-y-3 rounded-md border bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{lead.name}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{lead.phone}</p>
                  </div>
                  <Button type="button" size="sm" variant={call.activityId ? "outline" : "default"} onClick={() => void call.start()} disabled={call.starting || pending}>
                    {call.starting ? <Loader2 className="animate-spin" /> : <Phone />} {call.activityId ? "Call again" : "Call"}
                  </Button>
                </div>
                {call.activityId ? (
                  <Field>
                    <FieldLabel className="flex items-center gap-1.5 text-xs">
                      <CheckCircle2 className="size-3.5 text-emerald-500" /> Call logged. How did it go?
                    </FieldLabel>
                    <CallOutcomePicker value={callResult} onChange={setCallResult} />
                  </Field>
                ) : null}
              </div>
            ) : null}
            <Field>
              <FieldLabel htmlFor="fu-outcome">{lead ? "Notes" : "Outcome"} <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
              <Textarea id="fu-outcome" rows={3} maxLength={1000} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Spoke to owner, wants a proposal" />
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="fu-next" checked={scheduleNext} onCheckedChange={(c) => setScheduleNext(c === true)} />
              <FieldLabel htmlFor="fu-next" className="font-normal">Schedule the next follow-up</FieldLabel>
            </Field>
            {scheduleNext ? (
              <div className="space-y-3 rounded-md border bg-muted/30 p-3">
                <Field>
                  <FieldLabel htmlFor="fu-next-task">Next task</FieldLabel>
                  <Input id="fu-next-task" value={nextTask} maxLength={500} onChange={(e) => setNextTask(e.target.value)} placeholder="Follow up" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="fu-next-date">Due (IST)</FieldLabel>
                  <DateTimeField idPrefix="fu-next" value={when} onChange={setWhen} />
                </Field>
              </div>
            ) : null}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button type="submit" form="fu-complete" disabled={pending}>{pending && <Loader2 className="animate-spin" />}{call.activityId ? "Save & complete" : "Mark complete"}</Button>
        </DialogFooter>
      </DialogContent>
      {lead ? <CallQrDialog open={call.qrOpen} onClose={call.closeQr} phone={lead.phone} leadName={lead.name} /> : null}
    </>
  );
}
