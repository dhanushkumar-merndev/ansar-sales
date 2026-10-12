"use client";

import { useMemo, useState, useTransition } from "react";
import { ArrowLeft, ArrowRight, Calculator, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { ColorSwatchPicker } from "@/components/common/color-swatch-picker";
import { DateField } from "@/components/common/date-time-field";
import { ColorDot } from "@/components/projects/project-badges";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveQuery } from "@/hooks/use-live-query";
import { formatINR } from "@/lib/format";
import { fetchRolePeople, type RolePerson } from "@/lib/project-queries";
import { defaultScheduleRows, scheduleExcess, scheduleExcessMessage, scheduleToMilestones, schedulePercentTotal, sumAmounts, spreadTemplate, type PhaseDraft, type ProjectColor, type ScheduleRow } from "@/lib/projects";
import { addDays, formatCalendarDate, istToday } from "@/lib/time";
import { createProject } from "@/server/actions/projects";

export type ProjectSourceLead = { id: string; name: string; phone?: string | null; email?: string | null };

const empty = (lead?: ProjectSourceLead | null) => ({
  name: lead ? `${lead.name} residence` : "",
  clientName: lead?.name ?? "",
  clientPhone: lead?.phone ?? "",
  clientEmail: lead?.email ?? "",
  siteAddress: "",
  startDate: istToday(),
  endDate: addDays(istToday(), 45),
  color: "emerald" as ProjectColor,
  lengthFt: "",
  widthFt: "",
  areaSqft: "",
  ratePerSqft: "",
  contractValue: "",
  architectManagerId: "",
  designerIds: [] as string[],
  executionIds: [] as string[],
  useTemplate: true,
  markWon: true,
});

/** Admin: create a project (usually from a handed-over lead) in two short steps. */
export function CreateProjectDialog({ open, onOpenChange, lead, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; lead?: ProjectSourceLead | null; onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState(() => empty(lead));
  const [step, setStep] = useState<1 | 2>(1);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const [schedule, setSchedule] = useState<ScheduleRow[]>(() => defaultScheduleRows(istToday()));
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const key = open ? (lead?.id ?? "new") : null;
  if (key !== openedFor) {
    setOpenedFor(key);
    if (open) { setForm(empty(lead)); setSchedule(defaultScheduleRows(istToday())); setStep(1); setErrors({}); }
  }
  const set = <K extends keyof ReturnType<typeof empty>>(k: K, v: ReturnType<typeof empty>[K]) => setForm((f) => ({ ...f, [k]: v }));

  const people = (role: "architect_manager" | "landscape_designer" | "execution") => ({
    queryKey: `role-people:${role}`, fetcher: (s: AbortSignal) => fetchRolePeople(role, s), enabled: open, tables: ["profiles"],
  });
  const managers = useLiveQuery(people("architect_manager"));
  const designers = useLiveQuery(people("landscape_designer"));
  const execution = useLiveQuery(people("execution"));

  const phases = useMemo(() => form.useTemplate && form.endDate >= form.startDate ? spreadTemplate(form.startDate, form.endDate) : [],
    [form.useTemplate, form.startDate, form.endDate]);

  const milestones = useMemo(() => scheduleToMilestones(schedule, phases, form.contractValue ? Number(form.contractValue) : null, form.startDate),
    [schedule, phases, form.contractValue, form.startDate]);
  const scheduleOk = schedule.every((r) => r.label.trim() && Number(r.percent) > 0 && Number(r.percent) <= 100);

  // Length × width fills the area, and area × rate fills the contract value, as they are typed.
  const setMeasure = (k: "lengthFt" | "widthFt" | "areaSqft" | "ratePerSqft", v: string) => setForm((f) => {
    const next = { ...f, [k]: v };
    const l = Number(next.lengthFt), w = Number(next.widthFt);
    if ((k === "lengthFt" || k === "widthFt") && next.lengthFt.trim() && next.widthFt.trim() && l > 0 && w > 0) next.areaSqft = String(Math.round(l * w * 100) / 100);
    const a = Number(next.areaSqft), r = Number(next.ratePerSqft);
    if (next.areaSqft.trim() && next.ratePerSqft.trim() && a > 0 && r >= 0) next.contractValue = String(Math.round(a * r * 100) / 100);
    return next;
  });

  const calcArea = () => {
    const l = Number(form.lengthFt), w = Number(form.widthFt);
    if (l > 0 && w > 0) set("areaSqft", String(Math.round(l * w * 100) / 100));
  };
  const calcValue = () => {
    const a = Number(form.areaSqft), r = Number(form.ratePerSqft);
    if (a > 0 && r >= 0) set("contractValue", String(Math.round(a * r * 100) / 100));
  };

  const stepOneOk = form.name.trim() && form.clientName.trim() && form.startDate && form.endDate && form.endDate >= form.startDate;

  const scheduled = sumAmounts(milestones.map((m) => m.amount));
  const submit = () => {
    // Nothing is created: say why (the parts ask for more than the contract value).
    if (scheduleExcess(form.contractValue, scheduled)) return void toast.error(scheduleExcessMessage(scheduled, form.contractValue), { duration: 10_000 });
    create();
  };
  const create = () => start(async () => {
    const res = await createProject({
      leadId: lead?.id, name: form.name, clientName: form.clientName, clientPhone: form.clientPhone, clientEmail: form.clientEmail,
      siteAddress: form.siteAddress, startDate: form.startDate, endDate: form.endDate, color: form.color,
      areaSqft: form.areaSqft, ratePerSqft: form.ratePerSqft, contractValue: form.contractValue,
      architectManagerId: form.architectManagerId || undefined, designerIds: form.designerIds, executionIds: form.executionIds,
      phases, milestones, markWon: Boolean(lead) && form.markWon,
    });
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      if (res.fieldErrors && Object.keys(res.fieldErrors).some((k) => ["name", "clientName", "clientPhone", "clientEmail", "endDate"].includes(k))) setStep(1);
      toast.error(res.error);
      return;
    }
    toast.success(`Project "${form.name.trim()}" created`);
    onOpenChange(false);
    onCreated(res.data.id);
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{lead ? `New project for ${lead.name}` : "New project"}</DialogTitle>
          <DialogDescription>Step {step} of 2 · {step === 1 ? "Client, site, dates and value" : "Team and timeline"}</DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <Field data-invalid={!!errors.name}>
                <FieldLabel htmlFor="p-name">Project name</FieldLabel>
                <Input id="p-name" value={form.name} maxLength={120} placeholder="e.g. Mr. Hari Residence" onChange={(e) => set("name", e.target.value)} />
                <FieldError errors={errors.name?.map((message) => ({ message }))} />
              </Field>
              <Field>
                <FieldLabel htmlFor="p-color">Colour</FieldLabel>
                <ColorSwatchPicker id="p-color" value={form.color} onChange={(c) => set("color", c)} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.clientName}>
                <FieldLabel htmlFor="p-client">Client name</FieldLabel>
                <Input id="p-client" value={form.clientName} maxLength={120} onChange={(e) => set("clientName", e.target.value)} />
              </Field>
              <Field data-invalid={!!errors.clientPhone}>
                <FieldLabel htmlFor="p-phone">Client phone</FieldLabel>
                <Input id="p-phone" type="tel" value={form.clientPhone} maxLength={32} onChange={(e) => set("clientPhone", e.target.value)} />
                <FieldError errors={errors.clientPhone?.map((message) => ({ message }))} />
              </Field>
            </div>
            <Field data-invalid={!!errors.siteAddress}>
              <FieldLabel htmlFor="p-site">Site address</FieldLabel>
              <Input id="p-site" value={form.siteAddress} maxLength={500} placeholder="The site pin can be captured on the first site visit" onChange={(e) => set("siteAddress", e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="p-start">Start date</FieldLabel>
                <DateField id="p-start" value={form.startDate} onChange={(v) => set("startDate", v)} />
              </Field>
              <Field data-invalid={!!errors.endDate || form.endDate < form.startDate}>
                <FieldLabel htmlFor="p-end">End date</FieldLabel>
                <DateField id="p-end" value={form.endDate} onChange={(v) => set("endDate", v)} invalid={form.endDate < form.startDate} />
                {form.endDate < form.startDate ? <FieldError>End date is before the start</FieldError> : null}
              </Field>
            </div>
            <fieldset className="rounded-lg border p-3">
              <legend className="px-1 text-sm font-medium">Project value <span className="font-normal text-muted-foreground">(optional, seen by Admin and Accounts only)</span></legend>
              <div className="grid grid-cols-[1fr_auto_1fr_auto] items-end gap-2">
                <Field><FieldLabel htmlFor="p-l" className="text-xs">Length (ft)</FieldLabel><Input id="p-l" inputMode="decimal" value={form.lengthFt} onChange={(e) => setMeasure("lengthFt", e.target.value)} /></Field>
                <span className="pb-2 text-muted-foreground">×</span>
                <Field><FieldLabel htmlFor="p-w" className="text-xs">Width (ft)</FieldLabel><Input id="p-w" inputMode="decimal" value={form.widthFt} onChange={(e) => setMeasure("widthFt", e.target.value)} /></Field>
                <Button type="button" variant="outline" size="icon" aria-label="Calculate area" onClick={calcArea}><Calculator /></Button>
              </div>
              <div className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                <Field data-invalid={!!errors.areaSqft}><FieldLabel htmlFor="p-area" className="text-xs">Area (sq ft)</FieldLabel><Input id="p-area" inputMode="decimal" value={form.areaSqft} onChange={(e) => setMeasure("areaSqft", e.target.value)} /></Field>
                <Field data-invalid={!!errors.ratePerSqft}><FieldLabel htmlFor="p-rate" className="text-xs">Rate (₹ / sq ft)</FieldLabel><Input id="p-rate" inputMode="decimal" value={form.ratePerSqft} onChange={(e) => setMeasure("ratePerSqft", e.target.value)} /></Field>
                <Button type="button" variant="outline" size="icon" aria-label="Calculate value" onClick={calcValue}><Calculator /></Button>
              </div>
              <Field className="mt-3" data-invalid={!!errors.contractValue}>
                <FieldLabel htmlFor="p-value" className="text-xs">Contract value (₹)</FieldLabel>
                <Input id="p-value" inputMode="decimal" value={form.contractValue} onChange={(e) => set("contractValue", e.target.value)} />
                <FieldDescription>{form.contractValue && Number(form.contractValue) >= 0 ? formatINR(form.contractValue) : "Area × rate, or type the agreed total."}</FieldDescription>
                <FieldError errors={errors.contractValue?.map((message) => ({ message }))} />
              </Field>
            </fieldset>
          </FieldGroup>
        ) : (
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="p-am">Architect manager</FieldLabel>
              <Select value={form.architectManagerId || "__none"} onValueChange={(v) => set("architectManagerId", v === "__none" ? "" : v)}>
                <SelectTrigger id="p-am" className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Not yet</SelectItem>
                  {(managers.data ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.display_name}</SelectItem>)}
                </SelectContent>
              </Select>
              {managers.data && managers.data.length === 0 ? <FieldDescription>No one has the Architect manager role yet. Add it in Users.</FieldDescription> : null}
            </Field>
            <PeoplePicker label="Landscape designers" people={designers.data} value={form.designerIds} onChange={(v) => set("designerIds", v)} empty="No landscape designers yet. Add the role in Users." />
            <PeoplePicker label="Execution manager" people={execution.data} value={form.executionIds} onChange={(v) => set("executionIds", v)} empty="No execution managers yet. You can add them later." />
            <div className="rounded-lg border">
              <label className="flex cursor-pointer items-center gap-2 border-b px-3 py-2.5 text-sm font-medium">
                <Checkbox checked={form.useTemplate} onCheckedChange={(v) => set("useTemplate", v === true)} />
                Start with the Star Gardens timeline
              </label>
              {form.useTemplate ? (
                <ol className="max-h-56 divide-y overflow-y-auto text-sm">
                  {phases.map((p, i) => (
                    <li key={i} className="flex items-center gap-2 px-3 py-2">
                      <ColorDot color={p.color} />
                      <span className="min-w-0 flex-1 truncate">{p.name}<span className="ml-1.5 text-xs text-muted-foreground">{p.category}</span></span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatCalendarDate(p.planned_start)} – {formatCalendarDate(p.deadline)}</span>
                    </li>
                  ))}
                </ol>
              ) : <p className="px-3 py-2.5 text-sm text-muted-foreground">You can add phases on the Timeline tab.</p>}
            </div>
            <ScheduleEditor rows={schedule} onChange={setSchedule} phases={phases} amounts={milestones.map((m) => m.amount)}
              hasValue={Number(form.contractValue) > 0} startDate={form.startDate} />
            {lead ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={form.markWon} onCheckedChange={(v) => set("markWon", v === true)} />
                Mark the lead as closed (won)
              </label>
            ) : null}
          </FieldGroup>
        )}

        <DialogFooter className="gap-2">
          {step === 2 ? <Button variant="outline" onClick={() => setStep(1)} disabled={pending}><ArrowLeft /> Back</Button>
            : <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>}
          {step === 1 ? <Button disabled={!stepOneOk} onClick={() => setStep(2)}>Next <ArrowRight /></Button>
            : <Button disabled={pending || !scheduleOk} onClick={submit}>{pending && <Loader2 className="animate-spin" />}Create project</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PeoplePicker({ label, people, value, onChange, empty }: {
  label: string; people: RolePerson[] | undefined; value: string[]; onChange: (v: string[]) => void; empty: string;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      {people && people.length === 0 ? <FieldDescription>{empty}</FieldDescription> : (
        <div className="grid grid-cols-2 gap-2">
          {(people ?? []).map((p) => (
            <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-sm has-[:checked]:border-primary/40 has-[:checked]:bg-primary/5">
              <Checkbox checked={value.includes(p.id)} onCheckedChange={(on) => onChange(on ? [...value, p.id] : value.filter((x) => x !== p.id))} />
              <span className="truncate">{p.display_name}</span>
            </label>
          ))}
        </div>
      )}
    </Field>
  );
}

/** The payment parts, editable before the project is created (Accounts can still change them later). */
function ScheduleEditor({ rows, onChange, phases, amounts, hasValue, startDate }: {
  rows: ScheduleRow[]; onChange: (rows: ScheduleRow[]) => void; phases: PhaseDraft[]; amounts: string[]; hasValue: boolean; startDate: string;
}) {
  const total = schedulePercentTotal(rows);
  const update = (i: number, patch: Partial<ScheduleRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="rounded-lg border px-3 py-2.5 text-sm">
      <legend className="px-1 font-medium">Payment schedule <span className="font-normal text-muted-foreground">(the client can pay any amount; it fills these parts in order)</span></legend>
      <ul className="space-y-2">
        {rows.map((r, i) => {
          const phaseMissing = r.due_trigger === "phase" && !phases.some((p) => p.name === r.phase_name);
          return (
            <li key={i} className="grid grid-cols-[1fr_4.5rem_auto] items-start gap-2 sm:grid-cols-[1fr_4.5rem_12rem_auto]">
              <Input aria-label={`Part ${i + 1} name`} value={r.label} maxLength={80} placeholder="e.g. Advance" onChange={(e) => update(i, { label: e.target.value })} />
              <Input aria-label={`Part ${i + 1} percent`} inputMode="decimal" value={r.percent} onChange={(e) => update(i, { percent: e.target.value })}
                aria-invalid={!(Number(r.percent) > 0 && Number(r.percent) <= 100)} />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove part ${i + 1}`} className="sm:order-last" disabled={rows.length === 1}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}><X /></Button>
              <div className="col-span-2 space-y-1 sm:col-span-1">
                <Select value={r.due_trigger === "phase" ? `phase:${r.phase_name}` : "date"}
                  onValueChange={(v) => update(i, v === "date" ? { due_trigger: "date" } : { due_trigger: "phase", phase_name: v.slice(6) })}>
                  <SelectTrigger aria-label={`Part ${i + 1} due`} className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="date">On a date</SelectItem>
                    {phases.map((p) => <SelectItem key={p.name} value={`phase:${p.name}`}>When “{p.name}” is done</SelectItem>)}
                    {phaseMissing ? <SelectItem value={`phase:${r.phase_name}`}>When “{r.phase_name}” is done</SelectItem> : null}
                  </SelectContent>
                </Select>
                {r.due_trigger === "date" ? <DateField id={`p-ms-${i}-date`} value={r.due_date || startDate} onChange={(v) => update(i, { due_date: v })} /> : null}
                {phaseMissing ? <p className="text-xs text-amber-300">Not in the timeline: due on the start date instead.</p> : null}
              </div>
              {hasValue ? <span className="col-span-3 -mt-1 text-xs tabular-nums text-muted-foreground sm:col-span-4">{formatINR(amounts[i])}</span> : null}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" disabled={rows.length >= 20}
          onClick={() => onChange([...rows, { label: "", percent: String(Math.max(0, 100 - total) || 10), due_trigger: "date", due_date: startDate, phase_name: "" }])}>
          <Plus /> Add part
        </Button>
        <span className={total === 100 ? "text-xs text-muted-foreground" : total > 100 ? "text-xs text-red-300" : "text-xs text-amber-300"} aria-live="polite">
          Total {total}%{total === 100 ? "" : total > 100 ? " — more than the contract value; it can't be saved" : " — usually 100%"}
        </span>
      </div>
    </fieldset>
  );
}
