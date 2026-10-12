"use client";

import { useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, CalendarIcon, ChevronDown, ChevronUp, PanelRightOpen, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ColorDot, LateBadge } from "@/components/projects/project-badges";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PHASE_STATUS_LABELS, type Phase, type PhaseStatus, type ProjectDetail, phaseStatusChoices } from "@/lib/projects";
import { addDays, formatCalendarDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  addPhaseItem, addPhaseQuick, archivePhase, patchPhase, renameStage, reorderPhaseItems, reorderPhases, updatePhaseItem, updatePhaseProgress,
} from "@/server/actions/projects";

type Result = { ok: true; data?: unknown } | { ok: false; error: string };

/** Days between two YYYY-MM-DD dates. */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromYmd = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

/**
 * The timeline as a sheet, like the office's Excel timeline: S.No · Description (with its steps) ·
 * Stage (merged across its phases) · Start · Deadline · Submitted · Delay · Status · Owner · Remark.
 * Every cell edits in place: click, type, Enter (Esc cancels). Managers shape the plan (phases,
 * stages, dates, owners); a phase owner reports progress (status, submitted date, steps, remark).
 */
export function PhaseSheet({ detail, onOpen, onChanged }: { detail: ProjectDetail; onOpen: (p: Phase) => void; onChanged: () => void }) {
  const me = useProfile();
  const [pending, start] = useTransition();
  const phases = detail.phases;
  const manage = detail.can.manage;
  const projectId = detail.project.id;
  // The newest version saved from here, so quick edits in a row don't trip over a refresh still on its way.
  const versions = useRef(new Map<string, number>());
  const version = (p: Phase) => Math.max(p.version, versions.current.get(p.id) ?? 0);
  // Rows a stage cell spans (consecutive phases of the same stage merge, like merged Excel cells).
  const spans = phases.map((p, i) => {
    if (i > 0 && phases[i - 1].category === p.category) return 0;
    let n = 1;
    while (i + n < phases.length && phases[i + n].category === p.category) n++;
    return n;
  });
  const members = [...new Map(detail.members.map((m) => [m.id, m])).values()];

  const run = (fn: () => Promise<Result>, done?: string) => start(async () => {
    const r = await fn();
    if (!r.ok) return void toast.error(r.error);
    if (done) toast.success(done);
    onChanged();
  });
  const patch = (p: Phase, fields: Record<string, unknown>, done?: string) => run(async () => {
    const r = await patchPhase({ id: p.id, version: version(p), ...fields });
    if (r.ok) versions.current.set(p.id, r.data.version);
    return r;
  }, done);
  const move = (i: number, dir: -1 | 1) => run(() => {
    const ids = phases.map((p) => p.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    return reorderPhases({ projectId, ids });
  });
  const moveItem = (p: Phase, n: number, dir: -1 | 1) => run(() => {
    const ids = p.items.map((it) => it.id);
    [ids[n], ids[n + dir]] = [ids[n + dir], ids[n]];
    return reorderPhaseItems({ phaseId: p.id, ids });
  });
  const setStatus = (p: Phase, status: PhaseStatus) => run(async () => {
    const r = await updatePhaseProgress({ id: p.id, version: version(p), status });
    if (r.ok) versions.current.set(p.id, r.data.version);
    return r;
  }, `${p.name}: ${PHASE_STATUS_LABELS[status]}`);
  // Moving the start keeps the phase's length, so the deadline never ends up before it.
  const setStart = (p: Phase, v: string) => patch(p, { plannedStart: v, deadline: v > p.deadline ? addDays(v, daysBetween(p.planned_start, p.deadline)) : p.deadline });

  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[1180px]">
        <TableHeader>
          <TableRow className="bg-amber-300/10 hover:bg-amber-300/10">
            <TableHead className="w-12 text-center">S.No</TableHead>
            <TableHead className="min-w-72">Description</TableHead>
            <TableHead className="w-40">Stage</TableHead>
            <TableHead className="w-32">Start</TableHead>
            <TableHead className="w-32">Deadline</TableHead>
            <TableHead className="w-32">Submitted on</TableHead>
            <TableHead className="w-24">Delay</TableHead>
            <TableHead className="w-44">Status</TableHead>
            <TableHead className="w-36">Owner</TableHead>
            <TableHead className="min-w-40">Remark</TableHead>
            <TableHead className="w-24"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {phases.map((p, i) => {
            const progress = manage || p.owner?.id === me.id;
            const lastOfStage = phases[i + spans[i] - 1];
            return (
              <TableRow key={p.id} className={cn("group/row align-top", p.overdue && "bg-red-400/[0.04]")}>
                <TableCell className="text-center tabular-nums">{i + 1}</TableCell>
                <TableCell>
                  <div className="flex items-start gap-1.5">
                    <ColorDot color={p.color} className="mt-1.5" />
                    <InlineText value={p.name} editable={manage} required maxLength={120} label="description" className="font-medium"
                      onSave={(name) => patch(p, { name })} />
                  </div>
                  <ol className="mt-1 space-y-0.5 pl-4 text-xs text-muted-foreground">
                    {p.items.map((it, n) => (
                      <li key={it.id} className="group/item flex items-center gap-1.5">
                        <Checkbox className="size-3.5" checked={!!it.done_at} disabled={!progress || pending} aria-label={`${it.title} done`}
                          onCheckedChange={(v) => run(() => updatePhaseItem({ id: it.id, done: v === true }))} />
                        <span className="tabular-nums">{n + 1}.</span>
                        <InlineText value={it.title} editable={progress} required maxLength={200} label="step" className={cn("flex-1", it.done_at && "line-through")}
                          onSave={(title) => run(() => updatePhaseItem({ id: it.id, title }))} />
                        {progress ? (
                          <span className="flex opacity-0 group-hover/item:opacity-100 focus-within:opacity-100">
                            <Button variant="ghost" size="icon-xs" disabled={n === 0 || pending} aria-label={`Move ${it.title} up`} onClick={() => moveItem(p, n, -1)}><ChevronUp /></Button>
                            <Button variant="ghost" size="icon-xs" disabled={n === p.items.length - 1 || pending} aria-label={`Move ${it.title} down`} onClick={() => moveItem(p, n, 1)}><ChevronDown /></Button>
                            <Button variant="ghost" size="icon-xs" disabled={pending} aria-label={`Remove ${it.title}`} onClick={() => run(() => updatePhaseItem({ id: it.id, archived: true }))}><X /></Button>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                  {progress ? <AddInline label="Add step" placeholder="e.g. Planting plan" maxLength={200} className="mt-1 pl-4" keepOpen
                    onAdd={(title) => run(() => addPhaseItem({ phaseId: p.id, title }))} /> : null}
                </TableCell>
                {spans[i] ? (
                  <TableCell rowSpan={spans[i]} className="border-x text-center align-middle text-sm font-medium">
                    <InlineText value={p.category} editable={manage} required maxLength={60} label="stage" className="justify-center text-center"
                      onSave={(to) => run(() => renameStage({ projectId, from: p.category, to }), `Stage renamed to ${to}`)} />
                    {manage ? <AddInline label="Add phase" placeholder="Phase name" maxLength={120} className="mt-2 justify-center"
                      onAdd={(name) => run(() => addPhaseQuick({ projectId, category: p.category, name, afterId: lastOfStage.id }), `${name} added to ${p.category}`)} /> : null}
                  </TableCell>
                ) : null}
                <TableCell><InlineDate value={p.planned_start} editable={manage} label={`Start of ${p.name}`} onChange={(v) => setStart(p, v)} /></TableCell>
                <TableCell><InlineDate value={p.deadline} editable={manage} min={p.planned_start} label={`Deadline of ${p.name}`} onChange={(v) => patch(p, { deadline: v })} /></TableCell>
                <TableCell>
                  <InlineDate value={p.submitted_on} editable={progress} min={p.actual_start ?? undefined} label={`Submitted on, ${p.name}`}
                    onChange={(v) => patch(p, { submittedOn: v })} onClear={() => patch(p, { submittedOn: null })} />
                </TableCell>
                <TableCell>{p.late_days > 0 ? <LateBadge days={p.late_days} submitted={p.status === "in_review" || p.status === "done"} /> : <span className="text-sm text-muted-foreground">On time</span>}</TableCell>
                <TableCell>
                  <Select value={p.status} disabled={!progress || pending} onValueChange={(v) => setStatus(p, v as PhaseStatus)}>
                    <SelectTrigger size="sm" className="w-40" aria-label={`Status of ${p.name}`}><SelectValue /></SelectTrigger>
                    <SelectContent>{phaseStatusChoices(manage, p.status).map((s) => <SelectItem key={s} value={s}>{PHASE_STATUS_LABELS[s]}</SelectItem>)}</SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-sm">
                  {manage ? (
                    <Select value={p.owner?.id ?? "__none"} disabled={pending} onValueChange={(v) => patch(p, { ownerId: v === "__none" ? null : v })}>
                      <SelectTrigger size="sm" className="w-full border-transparent shadow-none hover:border-input" aria-label={`Owner of ${p.name}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none">Unassigned</SelectItem>
                        {members.map((m) => <SelectItem key={m.id} value={m.id}>{m.display_name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : p.owner?.display_name ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  <InlineText value={p.remark ?? ""} editable={progress} maxLength={500} label="remark" placeholder={progress ? "Add remark" : ""}
                    onSave={(remark) => patch(p, { remark: remark || null })} />
                </TableCell>
                <TableCell>
                  <div className="flex gap-0.5">
                    <Button variant="ghost" size="icon-sm" aria-label={`Open ${p.name}`} title="Open (notes, colour, files)" onClick={() => onOpen(p)}><PanelRightOpen /></Button>
                    {manage ? (
                      <>
                        <Button variant="ghost" size="icon-sm" disabled={i === 0 || pending} aria-label={`Move ${p.name} up`} onClick={() => move(i, -1)}><ArrowUp /></Button>
                        <Button variant="ghost" size="icon-sm" disabled={i === phases.length - 1 || pending} aria-label={`Move ${p.name} down`} onClick={() => move(i, 1)}><ArrowDown /></Button>
                        <ConfirmDialog
                          trigger={<Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-red-400" disabled={pending} aria-label={`Remove ${p.name}`}><Trash2 /></Button>}
                          title={`Remove "${p.name}"?`} description="It disappears from the timeline. Its history stays in Activity." confirmLabel="Remove" destructive
                          onConfirm={async () => {
                            const r = await archivePhase({ id: p.id });
                            if (!r.ok) { toast.error(r.error); return false; }
                            toast.success("Phase removed");
                            onChanged();
                          }}
                        />
                      </>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          {manage ? (
            <TableRow className="hover:bg-transparent">
              <TableCell />
              <TableCell colSpan={10}><AddStage pending={pending} onAdd={(category, name) => run(() => addPhaseQuick({ projectId, category, name }), `${category} added`)} /></TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      {!phases.length && !manage ? <p className="p-4 text-sm text-muted-foreground">No phases yet.</p> : null}
    </div>
  );
}

/** Text that turns into an input when clicked. Enter or leaving the field saves; Esc cancels. */
function InlineText({ value, editable, onSave, label, placeholder, required, maxLength, className }: {
  value: string; editable: boolean; onSave: (v: string) => void; label: string; placeholder?: string; required?: boolean; maxLength: number; className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  if (!editable) return <span className={cn("whitespace-pre-wrap", className)}>{value}</span>;
  if (draft === null) {
    return (
      <button type="button" aria-label={`Edit ${label}: ${value || "empty"}`} onClick={() => { cancelled.current = false; setDraft(value); }}
        className={cn("-mx-1 flex min-h-6 cursor-text rounded px-1 text-left whitespace-pre-wrap hover:bg-accent/60", className)}>
        {value || <span className="text-muted-foreground/70 italic">{placeholder}</span>}
      </button>
    );
  }
  const commit = () => {
    const v = draft.trim();
    setDraft(null);
    if (cancelled.current || v === value.trim() || (required && !v)) return;
    onSave(v);
  };
  return (
    <Input autoFocus value={draft} maxLength={maxLength} aria-label={label} className="h-7 px-1.5 text-sm" onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.currentTarget.select()} onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === "Escape") { cancelled.current = true; e.currentTarget.blur(); }
      }} />
  );
}

/** "+ Add …" that opens an input; Enter adds. With keepOpen it stays open for the next one. */
function AddInline({ label, placeholder, maxLength, onAdd, keepOpen, className }: {
  label: string; placeholder: string; maxLength: number; onAdd: (v: string) => void; keepOpen?: boolean; className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <div className={cn("flex", className)}>
        <button type="button" onClick={() => setDraft("")} className="inline-flex items-center gap-1 rounded px-1 text-xs text-muted-foreground opacity-70 hover:bg-accent/60 hover:text-foreground hover:opacity-100">
          <Plus className="size-3" />{label}
        </button>
      </div>
    );
  }
  const add = () => { const v = draft.trim(); if (v) onAdd(v); setDraft(keepOpen && v ? "" : null); };
  return (
    <div className={cn("flex", className)}>
      <Input autoFocus value={draft} maxLength={maxLength} placeholder={placeholder} aria-label={label} className="h-7 px-1.5 text-sm"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { const v = draft.trim(); if (v) onAdd(v); setDraft(null); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); add(); }
          if (e.key === "Escape") setDraft(null);
        }} />
    </div>
  );
}

/** A date cell: click for a calendar. Dates before `min` can't be picked. */
function InlineDate({ value, editable, onChange, onClear, min, label }: {
  value: string | null; editable: boolean; onChange: (v: string) => void; onClear?: () => void; min?: string; label: string;
}) {
  const [open, setOpen] = useState(false);
  const text = value ? formatCalendarDate(value) : "—";
  if (!editable) return <span className="text-sm tabular-nums">{text}</span>;
  return (
    <div className="flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`${label}: ${value ? text : "not set"}`}
            className="-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-sm tabular-nums hover:bg-accent/60">
            {text}<CalendarIcon className="size-3 opacity-0 group-hover/row:opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar mode="single" selected={value ? fromYmd(value) : undefined} defaultMonth={fromYmd(value ?? min ?? ymd(new Date()))}
            disabled={min ? { before: fromYmd(min) } : undefined}
            onSelect={(d) => { if (d && ymd(d) !== value) onChange(ymd(d)); setOpen(false); }} />
        </PopoverContent>
      </Popover>
      {value && onClear ? (
        <Button variant="ghost" size="icon-xs" className="opacity-0 group-hover/row:opacity-60 hover:opacity-100" aria-label={`Clear ${label}`} onClick={onClear}><X /></Button>
      ) : null}
    </div>
  );
}

/** A new stage with its first phase. */
function AddStage({ onAdd, pending }: { onAdd: (category: string, name: string) => void; pending: boolean }) {
  const [form, setForm] = useState<{ category: string; name: string } | null>(null);
  if (!form) {
    return <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setForm({ category: "", name: "" })}><Plus /> Add stage</Button>;
  }
  const ok = form.category.trim() && form.name.trim();
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (!ok) return; onAdd(form.category.trim(), form.name.trim()); setForm(null); }}>
      <Input autoFocus value={form.category} maxLength={60} placeholder="Stage, e.g. Approvals" aria-label="Stage name" className="h-8 w-48"
        onChange={(e) => setForm({ ...form, category: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setForm(null)} />
      <Input value={form.name} maxLength={120} placeholder="First phase, e.g. Society NOC" aria-label="First phase name" className="h-8 w-64"
        onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setForm(null)} />
      <Button type="submit" size="sm" disabled={!ok || pending}>Add</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setForm(null)}>Cancel</Button>
    </form>
  );
}
