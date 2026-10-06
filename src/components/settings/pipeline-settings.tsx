"use client";

import { useState, useTransition } from "react";
import { Archive, ArrowDown, ArrowUp, Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { ListSkeleton } from "@/components/common/states";
import { useStages } from "@/components/providers/stages-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OUTCOME_LABELS, LEAD_OUTCOMES, type LeadOutcome } from "@/lib/constants";
import { STAGE_BADGE, STAGE_COLORS, type PipelineStage, type StageColor } from "@/lib/stages";
import { cn } from "@/lib/utils";
import { archivePipelineStage, reorderPipelineStages, savePipelineStage } from "@/server/actions/pipeline";

const KIND_HELP: Record<LeadOutcome, string> = {
  open: "Still being worked on: counts as an active lead.",
  won: "Closed as won: counts in wins and the win rate.",
  lost: "Closed as lost: counts in losses.",
};

/** Company admin: the company's own lead stages (order, names, colours, open/won/lost). */
export function PipelineSettings() {
  const { stages, loading } = useStages();
  const [editing, setEditing] = useState<PipelineStage | "new" | null>(null);
  const [archiving, setArchiving] = useState<PipelineStage | null>(null);
  const [moving, startMove] = useTransition();

  const move = (index: number, delta: -1 | 1) => {
    const next = [...stages];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    startMove(async () => {
      const r = await reorderPipelineStages({ ids: next.map((s) => s.id) });
      if (!r.ok) toast.error(r.error);
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Pipeline stages</CardTitle>
          <CardDescription>The steps a lead goes through in this company. Every lead is in exactly one stage.</CardDescription>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}><Plus /> Add stage</Button>
      </CardHeader>
      <CardContent>
        {loading ? <ListSkeleton rows={6} /> : (
          <ol className="divide-y rounded-lg border">
            {stages.map((s, i) => (
              <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="w-5 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <Badge variant="outline" className={cn("font-medium", STAGE_BADGE[s.color])}>{s.name}</Badge>
                <span className="text-xs text-muted-foreground">{OUTCOME_LABELS[s.kind]}</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="size-8" disabled={moving || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${s.name} up`}><ArrowUp /></Button>
                  <Button variant="ghost" size="icon" className="size-8" disabled={moving || i === stages.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${s.name} down`}><ArrowDown /></Button>
                  <Button variant="ghost" size="icon" className="size-8" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}><Pencil /></Button>
                  <Button variant="ghost" size="icon" className="size-8" onClick={() => setArchiving(s)} aria-label={`Archive ${s.name}`}><Archive /></Button>
                </div>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          A pipeline always keeps at least one open, one won and one lost stage. Renaming a stage keeps old timeline entries readable.
        </p>
      </CardContent>
      <StageDialog stage={editing} onClose={() => setEditing(null)} />
      <ArchiveStageDialog stage={archiving} others={stages.filter((s) => s.id !== archiving?.id)} onClose={() => setArchiving(null)} />
    </Card>
  );
}

function StageDialog({ stage, onClose }: { stage: PipelineStage | "new" | null; onClose: () => void }) {
  return (
    <Dialog open={stage !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        {stage !== null ? <StageForm key={stage === "new" ? "new" : stage.id} stage={stage === "new" ? null : stage} onDone={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function StageForm({ stage, onDone }: { stage: PipelineStage | null; onDone: () => void }) {
  const [name, setName] = useState(stage?.name ?? "");
  const [kind, setKind] = useState<LeadOutcome>(stage?.kind ?? "open");
  const [color, setColor] = useState<StageColor>(stage?.color ?? "sky");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await savePipelineStage({ id: stage?.id ?? null, name, kind, color });
      if (!r.ok) return setError(r.error);
      toast.success(stage ? "Stage saved" : `${name.trim()} added`);
      onDone();
    });
  };

  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{stage ? "Edit stage" : "Add stage"}</DialogTitle>
        <DialogDescription>{stage ? "Changes apply to every lead in this stage." : "New open stages go just before the won and lost stages. Reorder them after."}</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="stage-name">Name</FieldLabel>
          <Input id="stage-name" value={name} maxLength={40} required autoFocus placeholder="e.g. Site visit" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="stage-kind">Counts as</FieldLabel>
          <Select value={kind} onValueChange={(v) => setKind(v as LeadOutcome)}>
            <SelectTrigger id="stage-kind" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{LEAD_OUTCOMES.map((k) => <SelectItem key={k} value={k}>{OUTCOME_LABELS[k]}</SelectItem>)}</SelectContent>
          </Select>
          <FieldDescription>{KIND_HELP[kind]}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Colour</FieldLabel>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
            {STAGE_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c} onClick={() => setColor(c)}
                className={cn("rounded-md border px-2 py-1 text-xs capitalize", STAGE_BADGE[c], c === color && "ring-2 ring-ring ring-offset-1 ring-offset-background")}>
                {c}
              </button>
            ))}
          </div>
        </Field>
      </FieldGroup>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      <DialogFooter>
        <Button type="submit" disabled={pending || !name.trim()}>{pending ? <Loader2 className="animate-spin" /> : null} Save</Button>
      </DialogFooter>
    </form>
  );
}

function ArchiveStageDialog({ stage, others, onClose }: { stage: PipelineStage | null; others: PipelineStage[]; onClose: () => void }) {
  const [moveTo, setMoveTo] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () => {
    if (!stage) return;
    start(async () => {
      const r = await archivePipelineStage({ id: stage.id, moveTo: moveTo || undefined });
      if (!r.ok) return setError(r.error);
      toast.success(r.data.moved ? `${stage.name} archived · ${r.data.moved} leads moved` : `${stage.name} archived`);
      setMoveTo("");
      setError(null);
      onClose();
    });
  };

  return (
    <Dialog open={stage !== null} onOpenChange={(o) => { if (!o) { setMoveTo(""); setError(null); onClose(); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Archive {stage?.name}?</DialogTitle>
          <DialogDescription>Leads in this stage move to the stage you pick (each lead&apos;s timeline records it). Old history keeps the name.</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="stage-move">Move its leads to</FieldLabel>
          <Select value={moveTo} onValueChange={setMoveTo}>
            <SelectTrigger id="stage-move" className="w-full"><SelectValue placeholder="Only needed if it has leads" /></SelectTrigger>
            <SelectContent>{others.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <DialogFooter>
          <Button variant="destructive" onClick={submit} disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : <Archive />} Archive stage</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
