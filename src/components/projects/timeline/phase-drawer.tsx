"use client";

import { useState, useTransition } from "react";
import { Archive, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { ColorSwatchPicker } from "@/components/common/color-swatch-picker";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DateField } from "@/components/common/date-time-field";
import { RichTextEditor, type RichDoc } from "@/components/common/rich-text";
import { LateBadge, PhaseStatusBadge } from "@/components/projects/project-badges";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PHASE_STATUS_LABELS, phaseLateDays, type Phase, type PhaseStatus, type ProjectColor, type ProjectDetail, phaseStatusChoices } from "@/lib/projects";
import { formatDateTime, istToday } from "@/lib/time";
import { archivePhase, savePhase, savePhaseChecklist, updatePhaseProgress } from "@/server/actions/projects";

type Form = {
  name: string; category: string; color: ProjectColor; ownerId: string | null; plannedStart: string; deadline: string;
  actualStart: string | null; submittedOn: string | null; status: PhaseStatus; needsClientApproval: boolean; remark: string; notes: RichDoc | null;
};

/** A checklist line while the drawer is open; nothing is saved until Save. */
type DraftItem = { key: string; id: string | null; title: string; done: boolean; doneBy: string | null; removed: boolean };
const itemsFor = (phase: Phase | null): DraftItem[] =>
  (phase?.items ?? []).map((it) => ({ key: it.id, id: it.id, title: it.title, done: !!it.done_at, doneBy: it.done_by, removed: false }));

/** What Save has to send for the checklist (empty when nothing changed). */
function checklistDiff(phase: Phase | null, items: DraftItem[]) {
  const before = new Map((phase?.items ?? []).map((it) => [it.id, !!it.done_at]));
  return {
    add: items.filter((i) => !i.id && !i.removed).map((i) => ({ title: i.title, done: i.done })),
    change: items.filter((i) => i.id && !i.removed && before.get(i.id) !== i.done).map((i) => ({ id: i.id!, done: i.done })),
    remove: items.filter((i) => i.id && i.removed).map((i) => i.id!),
  };
}

function formFor(phase: Phase | null, detail: ProjectDetail): Form {
  if (!phase) {
    const last = detail.phases.at(-1);
    const start = last?.deadline && last.deadline < detail.project.end_date ? last.deadline : detail.project.start_date;
    return {
      name: "", category: last?.category ?? "Design", color: last?.color ?? "emerald", ownerId: null, plannedStart: start, deadline: detail.project.end_date,
      actualStart: null, submittedOn: null, status: "not_started", needsClientApproval: false, remark: "", notes: null,
    };
  }
  return {
    name: phase.name, category: phase.category, color: phase.color, ownerId: phase.owner?.id ?? null, plannedStart: phase.planned_start,
    deadline: phase.deadline, actualStart: phase.actual_start, submittedOn: phase.submitted_on, status: phase.status,
    needsClientApproval: phase.needs_client_approval, remark: phase.remark ?? "", notes: (phase.notes as RichDoc | null) ?? null,
  };
}

/**
 * One phase in a side sheet: managers edit everything; the phase owner reports progress (status,
 * actual dates, checklist, notes). Background refreshes never overwrite what is being typed; a
 * concurrent edit is reported instead of silently replaced.
 */
export function PhaseDrawer({ phase, creating = false, detail, onClose, onChanged }: {
  phase: Phase | null; creating?: boolean; detail: ProjectDetail; onClose: () => void; onChanged: () => void;
}) {
  const me = useProfile();
  const open = creating || !!phase;
  const [form, setForm] = useState<Form>(() => formFor(phase, detail));
  const [items, setItems] = useState<DraftItem[]>(() => itemsFor(phase));
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const key = open ? (phase?.id ?? "new") : null;
  if (key !== openedFor) {
    setOpenedFor(key);
    if (open) { setForm(formFor(phase, detail)); setItems(itemsFor(phase)); }
  }
  const [pending, start] = useTransition();
  const [newItem, setNewItem] = useState("");
  const manage = detail.can.manage;
  const owner = !!phase && phase.owner?.id === me.id;
  const progress = manage || owner;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const categories = [...new Set(detail.phases.map((p) => p.category))];
  const today = istToday();
  const late = phaseLateDays({ status: form.status, deadline: form.deadline, submitted_on: form.submittedOn }, today);
  const submittedTooEarly = Boolean(form.actualStart && form.submittedOn && form.submittedOn < form.actualStart);
  const diff = checklistDiff(phase, items);
  const checklistChanged = diff.add.length + diff.change.length + diff.remove.length > 0;
  const formChanged = JSON.stringify(form) !== JSON.stringify(formFor(phase, detail));
  const dirty = !phase || formChanged || checklistChanged;

  const save = () => start(async () => {
    // The phase first (skipped when only the checklist changed), then its checklist.
    let phaseId = phase?.id ?? null;
    if (!phase || formChanged) {
      const r = manage
      ? await savePhase({
          projectId: detail.project.id, id: phase?.id, version: phase?.version, category: form.category, name: form.name, color: form.color,
          ownerId: form.ownerId, plannedStart: form.plannedStart, deadline: form.deadline, actualStart: form.actualStart,
          submittedOn: form.submittedOn, status: form.status, needsClientApproval: form.needsClientApproval, remark: form.remark, notes: form.notes,
        })
      : await updatePhaseProgress({
          id: phase!.id, version: phase!.version, status: form.status, actualStart: form.actualStart, submittedOn: form.submittedOn,
          remark: form.remark || null, notes: form.notes,
        });
      if (!r.ok) return void toast.error(r.error);
      const saved = r.data as { id?: string };
      if (saved.id) phaseId = saved.id;
    }
    if (checklistChanged && phaseId) {
      const c = await savePhaseChecklist({ phaseId, ...diff });
      if (!c.ok) { onChanged(); return void toast.error(`${phase ? "Saved, but the checklist wasn't" : "Phase added, but its checklist wasn't saved"}: ${c.error}`); }
    }
    toast.success(phase ? "Phase saved" : "Phase added");
    onChanged();
    onClose();
  });

  const setItem = (k: string, patch: Partial<DraftItem>) => setItems((list) => list.map((i) => (i.key === k ? { ...i, ...patch } : i)));
  // Removing a step that isn't saved yet just drops it; a saved one is marked and removed on Save.
  const removeItem = (it: DraftItem) => setItems((list) => (it.id ? list.map((i) => (i.key === it.key ? { ...i, removed: true } : i)) : list.filter((i) => i.key !== it.key)));
  const addItem = (title: string) => title.trim() && setItems((list) => [...list, { key: `new:${Date.now()}:${list.length}`, id: null, title: title.trim(), done: false, doneBy: null, removed: false }]);
  const canChecklist = phase ? progress : manage;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{phase ? phase.name : "New phase"}</SheetTitle>
          <SheetDescription>
            {phase ? <span className="inline-flex flex-wrap items-center gap-1.5"><PhaseStatusBadge status={phase.status} /><LateBadge days={late} submitted={form.status === "in_review" || form.status === "done"} />
              <span>Updated {formatDateTime(phase.updated_at)}</span></span> : `Add a phase to ${detail.project.name}.`}
          </SheetDescription>
        </SheetHeader>

        <FieldGroup className="gap-4 px-4">
          {manage ? (
            <>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <Field><FieldLabel htmlFor="ph-name">Description</FieldLabel><Input id="ph-name" value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} placeholder="e.g. GFC drawings" /></Field>
                <Field><FieldLabel htmlFor="ph-color">Colour</FieldLabel><ColorSwatchPicker id="ph-color" value={form.color} onChange={(c) => set("color", c)} /></Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="ph-cat">Stage</FieldLabel>
                  <Input id="ph-cat" list="ph-cat-list" value={form.category} maxLength={60} onChange={(e) => set("category", e.target.value)} />
                  <datalist id="ph-cat-list">{categories.map((c) => <option key={c} value={c} />)}</datalist>
                  <FieldDescription>Type a new name to add a stage.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="ph-owner">Owner</FieldLabel>
                  <Select value={form.ownerId ?? "__none"} onValueChange={(v) => set("ownerId", v === "__none" ? null : v)}>
                    <SelectTrigger id="ph-owner" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">Unassigned</SelectItem>
                      {[...new Map(detail.members.map((m) => [m.id, m])).values()].map((m) => <SelectItem key={m.id} value={m.id}>{m.display_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field><FieldLabel htmlFor="ph-start">Planned start</FieldLabel><DateField id="ph-start" value={form.plannedStart} onChange={(v) => set("plannedStart", v)} /></Field>
                <Field data-invalid={form.deadline < form.plannedStart}><FieldLabel htmlFor="ph-deadline">Deadline</FieldLabel><DateField id="ph-deadline" value={form.deadline} onChange={(v) => set("deadline", v)} invalid={form.deadline < form.plannedStart} /></Field>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={form.needsClientApproval} onCheckedChange={(v) => set("needsClientApproval", v === true)} /> Needs client approval
              </label>
            </>
          ) : null}

          <Field>
            <FieldLabel htmlFor="ph-status">Status</FieldLabel>
            <Select value={form.status} disabled={!progress} onValueChange={(v) => set("status", v as PhaseStatus)}>
              <SelectTrigger id="ph-status" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {phaseStatusChoices(manage, phase?.status ?? "not_started").map((s) => <SelectItem key={s} value={s}>{PHASE_STATUS_LABELS[s]}</SelectItem>)}
              </SelectContent>
            </Select>
            {!progress ? <FieldDescription>Only the phase owner or the architect manager can update this phase.</FieldDescription>
              : !manage ? <FieldDescription>Set it to “In review” when it&apos;s ready. The architect manager or an admin approves it (Done) or asks for changes.</FieldDescription> : null}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="ph-actual">Actually started</FieldLabel>
              <div className="flex gap-1"><div className="min-w-0 flex-1"><DateField id="ph-actual" value={form.actualStart ?? ""} onChange={(v) => set("actualStart", v || null)} /></div>
                {form.actualStart && progress ? <Button variant="ghost" size="icon" aria-label="Clear start" onClick={() => set("actualStart", null)}><X /></Button> : null}</div>
            </Field>
            <Field data-invalid={submittedTooEarly}>
              <FieldLabel htmlFor="ph-sub">Submitted on</FieldLabel>
              <div className="flex gap-1"><div className="min-w-0 flex-1"><DateField id="ph-sub" value={form.submittedOn ?? ""} onChange={(v) => set("submittedOn", v || null)} invalid={submittedTooEarly} /></div>
                {form.submittedOn && progress ? <Button variant="ghost" size="icon" aria-label="Clear submitted date" onClick={() => set("submittedOn", null)}><X /></Button> : null}</div>
              {submittedTooEarly ? <FieldError>Can&apos;t be before it started</FieldError> : null}
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="ph-remark">Remark</FieldLabel>
            <Input id="ph-remark" value={form.remark} disabled={!progress} maxLength={500} onChange={(e) => set("remark", e.target.value)} placeholder="Short note shown in the timeline sheet" />
          </Field>

          {phase || creating ? (
            <Field>
              <FieldLabel>Checklist</FieldLabel>
              <ul className="space-y-1">
                {items.filter((i) => !i.removed).map((it) => (
                  <li key={it.key} className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent/40">
                    <Checkbox id={`it-${it.key}`} checked={it.done} disabled={!canChecklist || pending} onCheckedChange={(v) => setItem(it.key, { done: v === true })} />
                    <label htmlFor={`it-${it.key}`} className={it.done ? "flex-1 text-sm text-muted-foreground line-through" : "flex-1 text-sm"}>{it.title}</label>
                    {!it.id ? <span className="text-[11px] text-sky-300">new</span> : it.done && it.doneBy ? <span className="text-xs text-muted-foreground">{it.doneBy}</span> : null}
                    {canChecklist ? (
                      <Button variant="ghost" size="icon-sm" className="opacity-60 group-hover:opacity-100" aria-label={`Remove ${it.title}`} disabled={pending}
                        onClick={() => removeItem(it)}><X /></Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {canChecklist ? (
                <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); addItem(newItem); setNewItem(""); }}>
                  <Input value={newItem} maxLength={200} onChange={(e) => setNewItem(e.target.value)} placeholder="Add an item, e.g. Planting plan" aria-label="New checklist item" />
                  <Button type="submit" variant="outline" size="icon" disabled={!newItem.trim() || pending} aria-label="Add item"><Plus /></Button>
                </form>
              ) : null}
              {checklistChanged ? <FieldDescription>Checklist changes are saved with Save; Cancel discards them.</FieldDescription> : null}
            </Field>
          ) : null}

          <Field>
            <FieldLabel>Notes</FieldLabel>
            <RichTextEditor key={phase?.id ?? "new"} value={form.notes} onChange={(d) => set("notes", d)} disabled={!progress} placeholder="Client feedback, decisions, what's next…" />
          </Field>
        </FieldGroup>

        <SheetFooter className="flex-row flex-wrap gap-2">
          {manage && phase ? (
            <ConfirmDialog
              trigger={<Button variant="ghost" className="text-red-400 hover:text-red-300" disabled={pending}><Archive /> Remove</Button>}
              title={`Remove "${phase.name}"?`} description="It disappears from the timeline. Its history stays in Activity."
              confirmLabel="Remove" destructive
              onConfirm={async () => {
                const r = await archivePhase({ id: phase.id });
                if (!r.ok) { toast.error(r.error); return false; }
                toast.success("Phase removed");
                onChanged();
                onClose();
              }}
            />
          ) : null}
          <span className="flex-1" />
          {phase && dirty ? <span className="self-center text-xs text-amber-200">Unsaved changes</span> : null}
          <Button variant="outline" onClick={onClose} disabled={pending}>{phase && dirty ? "Discard" : "Cancel"}</Button>
          {progress || (creating && manage) ? (
            <Button onClick={save} disabled={pending || !dirty || submittedTooEarly || (manage && (!form.name.trim() || !form.category.trim() || form.deadline < form.plannedStart))}>
              {pending && <Loader2 className="animate-spin" />}{phase ? "Save" : "Add phase"}
            </Button>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
