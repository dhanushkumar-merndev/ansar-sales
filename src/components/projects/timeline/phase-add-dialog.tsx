"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { DateField } from "@/components/common/date-time-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ProjectDetail } from "@/lib/projects";
import { addDays } from "@/lib/time";
import { addPhaseQuick, renameStage } from "@/server/actions/projects";

/**
 * What the Gantt's right-click menu asked for: a phase in a stage (after `afterId`), a new stage (its first
 * phase goes after `afterId`; none = at the end), or a new name for a stage.
 */
export type PhaseAddTarget =
  | { kind: "phase"; category: string; afterId?: string }
  | { kind: "stage"; afterId?: string; after?: string }
  | { kind: "rename"; category: string };

type Form = { stage: string; name: string; start: string; deadline: string };

function formFor(target: PhaseAddTarget | null, detail: ProjectDetail): Form {
  const { start_date: from, end_date: to } = detail.project;
  if (!target || target.kind === "rename") return { stage: target?.category ?? "", name: "", start: from, deadline: from };
  const after = target.afterId ? detail.phases.find((p) => p.id === target.afterId) : detail.phases.at(-1);
  // The day after the phase before it, a week long, inside the project's dates.
  let start = after ? addDays(after.deadline, 1) : from;
  if (start > to) start = to;
  if (start < from) start = from;
  const week = addDays(start, 6);
  return { stage: "", name: "", start, deadline: week > to ? to : week };
}

/** The small dialog behind the Gantt's right-click menu: add a phase, add a stage, or rename a stage. */
export function PhaseAddDialog({ target, detail, onClose, onChanged }: {
  target: PhaseAddTarget | null; detail: ProjectDetail; onClose: () => void; onChanged: () => void;
}) {
  const [form, setForm] = useState<Form>(() => formFor(target, detail));
  const [openedFor, setOpenedFor] = useState<PhaseAddTarget | null>(null);
  if (target !== openedFor) {
    setOpenedFor(target);
    if (target) setForm(formFor(target, detail));
  }
  const [pending, start] = useTransition();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const kind = target?.kind;
  const stages = [...new Set(detail.phases.map((p) => p.category))];
  const clash = (kind === "stage" || kind === "rename") && form.stage.trim()
    && stages.some((c) => c.toLowerCase() === form.stage.trim().toLowerCase() && !(target?.kind === "rename" && c === target.category));
  const datesWrong = form.deadline < form.start;
  const ready = kind === "rename"
    ? !!form.stage.trim() && !clash
    : !!form.name.trim() && !datesWrong && (kind !== "stage" || (!!form.stage.trim() && !clash));

  const save = () => target && ready && start(async () => {
    if (target.kind === "rename") {
      const r = await renameStage({ projectId: detail.project.id, from: target.category, to: form.stage.trim() });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Stage renamed");
    } else {
      const r = await addPhaseQuick({
        projectId: detail.project.id, category: target.kind === "stage" ? form.stage.trim() : target.category, name: form.name.trim(),
        afterId: target.afterId, plannedStart: form.start, deadline: form.deadline,
      });
      if (!r.ok) return void toast.error(r.error);
      toast.success(target.kind === "stage" ? "Stage added" : "Phase added");
    }
    onChanged();
    onClose();
  });

  const title = kind === "rename" ? "Rename stage" : kind === "stage" ? "Add a stage" : "Add a phase";
  const description = !target ? "" : target.kind === "rename" ? `Every phase in “${target.category}” moves to the new name.`
    : target.kind === "stage" ? (target.after ? `A new heading after “${target.after}”, with its first phase.` : "A new heading at the end, with its first phase.")
    : `In “${target.category}”${target.afterId ? `, after “${detail.phases.find((p) => p.id === target.afterId)?.name ?? "this phase"}”` : ""}.`;

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form id="phase-add" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <FieldGroup className="gap-4">
            {kind === "stage" || kind === "rename" ? (
              <Field data-invalid={!!clash}>
                <FieldLabel htmlFor="pa-stage">Stage name</FieldLabel>
                <Input id="pa-stage" autoFocus value={form.stage} maxLength={60} onChange={(e) => set("stage", e.target.value)} placeholder="e.g. Approvals" />
                {clash ? <FieldError>There&apos;s already a stage with that name.</FieldError> : null}
              </Field>
            ) : null}
            {kind !== "rename" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="pa-name">{kind === "stage" ? "First phase" : "Phase"}</FieldLabel>
                  <Input id="pa-name" autoFocus={kind === "phase"} value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Municipal approval" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field><FieldLabel htmlFor="pa-start">Planned start</FieldLabel><DateField id="pa-start" value={form.start} onChange={(v) => set("start", v)} /></Field>
                  <Field data-invalid={datesWrong}>
                    <FieldLabel htmlFor="pa-deadline">Deadline</FieldLabel>
                    <DateField id="pa-deadline" value={form.deadline} onChange={(v) => set("deadline", v)} invalid={datesWrong} />
                    {datesWrong ? <FieldError>Before the start</FieldError> : null}
                  </Field>
                </div>
                <FieldDescription>Owner, checklist and notes: open the phase afterwards.</FieldDescription>
              </>
            ) : null}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" form="phase-add" disabled={pending || !ready}>
            {pending && <Loader2 className="animate-spin" />}{kind === "rename" ? "Rename" : kind === "stage" ? "Add stage" : "Add phase"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
