"use client";

import { useEffect, useState, useTransition } from "react";
import { CircleX, Loader2, PhoneCall, PhoneMissed, PhoneOff, Timer } from "lucide-react";
import { useProfile } from "@/components/providers/profile-provider";
import { useStages } from "@/components/providers/stages-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { LEAD_TEMPERATURES, TEMPERATURE_LABELS, type LeadTemperature } from "@/lib/constants";
import { leadKey, type LeadDetail } from "@/lib/lead-queries";
import { CALL_OUTCOMES, type CallOutcome } from "@/lib/library";
import { fetchLead } from "@/lib/queries";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";

/** What the call screen saves in one go. stageId / temperature: undefined = leave as it is. */
export type WrapUp = { outcome: CallOutcome | null; note: string; stageId?: string; temperature?: LeadTemperature | null };
export const EMPTY_WRAP_UP: WrapUp = { outcome: null, note: "" };

const CLEAR = "__clear";

const OUTCOME_STYLE: Record<CallOutcome, { icon: React.ComponentType<{ className?: string }>; on: string }> = {
  connected: { icon: PhoneCall, on: "border-emerald-500/60 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/20" },
  no_answer: { icon: PhoneMissed, on: "border-amber-500/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/20" },
  busy: { icon: PhoneOff, on: "border-amber-500/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/20" },
  wrong_number: { icon: CircleX, on: "border-red-500/60 bg-red-500/15 text-red-200 hover:bg-red-500/20" },
};

/** Outcome buttons shared by the call screen and the follow-up completion dialog. `wide`: one row of four from small screens up. */
export function CallOutcomePicker({ value, onChange, wide }: { value: CallOutcome | null; onChange: (o: CallOutcome) => void; wide?: boolean }) {
  return (
    <div className={cn("grid grid-cols-2 gap-2", wide && "sm:grid-cols-4")} role="radiogroup" aria-label="Call outcome">
      {(Object.keys(CALL_OUTCOMES) as CallOutcome[]).map((o) => {
        const { icon: Icon, on } = OUTCOME_STYLE[o];
        return (
          <Button
            key={o}
            type="button"
            role="radio"
            aria-checked={value === o}
            variant="outline"
            className={cn("justify-center", value === o && on)}
            onClick={() => onChange(o)}
          >
            <Icon /> {CALL_OUTCOMES[o]}
          </Button>
        );
      })}
    </div>
  );
}

/** Talk time beside the call screen's title: a red dot while the call is running. */
export function TalkTimer({ seconds, live }: { seconds: number; live: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-sm" aria-live="off">
      {live ? <span className="size-2 rounded-full bg-red-500" aria-hidden /> : <Timer className="size-3.5 text-muted-foreground" aria-hidden />}
      <span className="text-muted-foreground">{live ? "On call" : "Talk time"}</span>
      <span className="font-medium tabular-nums">{formatDuration(seconds)}</span>
    </span>
  );
}

/** The lead as the call screen shows it (kept, so reopening the call screen shows it at once). */
export function useCallLead(leadId: string, enabled = true) {
  const profile = useProfile();
  return useLiveQuery({
    queryKey: leadKey(profile.id, leadId),
    fetcher: (s) => fetchLead(leadId, s),
    tables: ["leads"],
    match: ({ table, row }) => table !== "leads" || row.id === undefined || row.id === leadId,
    enabled: enabled && !!leadId,
    keep: true,
  });
}

/** Only what actually changes: a picked status or temperature equal to the lead's current one is left out. */
export function changesOf(w: WrapUp, lead: LeadDetail | null | undefined): WrapUp {
  return {
    outcome: w.outcome,
    note: w.note.trim(),
    stageId: w.stageId && w.stageId !== lead?.stage_id ? w.stageId : undefined,
    temperature: w.temperature !== undefined && w.temperature !== (lead?.temperature ?? null) ? w.temperature : undefined,
  };
}

export const isWrapUpDirty = (w: WrapUp) => w.outcome !== null || w.note.trim() !== "" || w.stageId !== undefined || w.temperature !== undefined;

/** Seconds since the call started, ticking every second (the measured time is saved on Save or Skip). */
export function useTalkSeconds(startedAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt === null ? null : Math.max(0, Math.round((now - startedAt) / 1000));
}

/**
 * Result, status, temperature and note for a call. Status and temperature start at the lead's current values.
 * compact: the narrow phone dialog (two outcome rows, talk time shown here); otherwise the call screen,
 * which shows the talk time in its title.
 */
export function CallWrapUpFields({ value, onChange, lead, talkSeconds, disabled, compact }: {
  value: WrapUp; onChange: (w: WrapUp) => void; lead: LeadDetail | null | undefined; talkSeconds: number | null; disabled?: boolean; compact?: boolean;
}) {
  const { stages, byId } = useStages();
  const stageId = value.stageId ?? lead?.stage_id;
  const current = lead ? byId.get(lead.stage_id) : undefined;
  const temperature = value.temperature === undefined ? (lead?.temperature ?? null) : value.temperature;
  return (
    <fieldset disabled={disabled} className="space-y-3">
      <Field>
        <FieldLabel>How did the call go?</FieldLabel>
        <CallOutcomePicker value={value.outcome} onChange={(outcome) => onChange({ ...value, outcome })} wide={!compact} />
      </Field>
      <div className={cn("grid grid-cols-2 gap-3", !compact && "xl:grid-cols-[minmax(0,11rem)_minmax(0,11rem)_minmax(0,1fr)]")}>
        <Field>
          <FieldLabel htmlFor="wrap-stage">Status</FieldLabel>
          <Select value={stageId ?? ""} disabled={!lead || stages.length === 0} onValueChange={(v) => onChange({ ...value, stageId: v })}>
            <SelectTrigger id="wrap-stage" className="w-full"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              {current?.archived_at ? <SelectItem value={current.id} disabled>{current.name}</SelectItem> : null}
              {stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="wrap-temp">Temperature</FieldLabel>
          <Select
            value={temperature ?? CLEAR}
            disabled={!lead}
            onValueChange={(v) => onChange({ ...value, temperature: v === CLEAR ? null : (v as LeadTemperature) })}
          >
            <SelectTrigger id="wrap-temp" className="w-full"><SelectValue placeholder="Not set" /></SelectTrigger>
            <SelectContent>
              {LEAD_TEMPERATURES.map((t) => <SelectItem key={t} value={t}>{TEMPERATURE_LABELS[t]}</SelectItem>)}
              <SelectItem value={CLEAR} className="text-muted-foreground">Not set</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field className={cn("col-span-2", !compact && "xl:col-span-1")}>
          <FieldLabel htmlFor="wrap-note">Note <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
          <Textarea
            id="wrap-note"
            rows={compact ? 3 : 2}
            maxLength={1000}
            className={cn(!compact && "min-h-9 xl:resize-none")}
            placeholder="e.g. Wants 2 plots, call back after 6 pm"
            value={value.note}
            onChange={(e) => onChange({ ...value, note: e.target.value })}
          />
        </Field>
      </div>
      {compact ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Timer className="size-3.5" aria-hidden /> Talk time
          <span className="font-medium text-foreground tabular-nums">{talkSeconds === null ? "—" : formatDuration(talkSeconds)}</span>
        </p>
      ) : null}
    </fieldset>
  );
}

/** "Save these?" step listing exactly what will be saved, in the order it goes into the history. */
export function WrapUpConfirm({ open, onOpenChange, changes, lead, talkSeconds, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; changes: WrapUp; lead: LeadDetail | null | undefined; talkSeconds: number | null;
  onConfirm: () => Promise<boolean>;
}) {
  const { byId } = useStages();
  const [pending, start] = useTransition();
  const temp = (t: LeadTemperature | null | undefined) => (t ? TEMPERATURE_LABELS[t] : "Not set");
  const rows: [string, string][] = [
    ["Call", [changes.outcome ? CALL_OUTCOMES[changes.outcome] : "", talkSeconds === null ? "" : formatDuration(talkSeconds)].filter(Boolean).join(" · ")],
    ...(changes.note ? [["Note", changes.note] as [string, string]] : []),
    ...(changes.stageId ? [["Status", `${byId.get(lead?.stage_id ?? "")?.name ?? "—"} → ${byId.get(changes.stageId)?.name ?? "—"}`] as [string, string]] : []),
    ...(changes.temperature !== undefined ? [["Temperature", `${temp(lead?.temperature)} → ${temp(changes.temperature)}`] as [string, string]] : []),
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save this call?</DialogTitle>
          <DialogDescription>This goes into the lead&apos;s history in this order.</DialogDescription>
        </DialogHeader>
        <dl className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="line-clamp-4 break-words whitespace-pre-wrap">{v}</dd>
            </div>
          ))}
        </dl>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Back</Button>
          <Button autoFocus disabled={pending} onClick={() => start(async () => { if (await onConfirm()) onOpenChange(false); })}>
            {pending && <Loader2 className="animate-spin" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
