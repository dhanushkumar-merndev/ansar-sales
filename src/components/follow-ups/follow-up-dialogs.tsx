"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { DateTimeField, type IstDateTime } from "@/components/common/date-time-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { addDays, istToUtcIso, istToday, utcToIstParts } from "@/lib/time";
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
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    setTask(followUp?.task ?? "");
    setWhen(followUp ? utcToIstParts(followUp.due_at) : { date: addDays(istToday(), 1), time: "10:00" });
    setError(null);
  }, [open, followUp]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const dueAt = toUtc(when);
    if (!task.trim()) return setError("Describe the task.");
    if (!dueAt) return setError("Pick a valid date and time.");
    if (new Date(dueAt).getTime() < Date.now() - 5 * 60_000) return setError("Choose a time in the future.");
    start(async () => {
      const r = followUp ? await rescheduleFollowUp({ id: followUp.id, task, dueAt }) : await scheduleFollowUp({ leadId, task, dueAt });
      if (!r.ok) return setError(r.error);
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
            {error ? <FieldError>{error}</FieldError> : null}
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

export function CompleteFollowUpDialog({
  open, onOpenChange, followUp, onDone,
}: { open: boolean; onOpenChange: (o: boolean) => void; followUp: { id: string; task: string } | null; onDone?: () => void }) {
  const [outcome, setOutcome] = useState("");
  const [scheduleNext, setScheduleNext] = useState(false);
  const [nextTask, setNextTask] = useState("");
  const [when, setWhen] = useState<IstDateTime>({ date: "", time: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    setOutcome("");
    setScheduleNext(false);
    setNextTask("");
    setWhen({ date: addDays(istToday(), 2), time: "10:00" });
    setError(null);
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!followUp) return;
    let nextDueAt: string | undefined;
    if (scheduleNext) {
      nextDueAt = toUtc(when) ?? undefined;
      if (!nextDueAt) return setError("Pick a valid date and time for the next follow-up.");
    }
    start(async () => {
      const r = await completeFollowUp({ id: followUp.id, outcome, nextDueAt, nextTask: scheduleNext ? nextTask : undefined });
      if (!r.ok) return setError(r.error);
      toast.success("Follow-up completed");
      onOpenChange(false);
      onDone?.();
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Complete follow-up</DialogTitle>
          <DialogDescription className="line-clamp-2">{followUp?.task}</DialogDescription>
        </DialogHeader>
        <form id="fu-complete" onSubmit={submit} noValidate>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="fu-outcome">Outcome <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
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
            {error ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button type="submit" form="fu-complete" disabled={pending}>{pending && <Loader2 className="animate-spin" />}Mark complete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
