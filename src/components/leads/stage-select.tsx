"use client";

import { useState, useTransition } from "react";
import { CircleDot, Loader2, Trophy, X } from "lucide-react";
import { toast } from "sonner";
import { useStages } from "@/components/providers/stages-provider";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { STAGE_BADGE } from "@/lib/stages";
import { cn } from "@/lib/utils";
import { setLeadStage } from "@/server/actions/leads";

/** Stage pill that opens a dropdown of the company's stages; saves on pick and reconciles with the server. */
export function StageSelect({ leadId, stageId, onChanged, className }: { leadId: string; stageId: string; onChanged: () => void; className?: string }) {
  const { stages, byId } = useStages();
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shown = byId.get(optimistic ?? stageId);
  const current = byId.get(stageId);
  const Icon = shown?.kind === "won" ? Trophy : shown?.kind === "lost" ? X : CircleDot;
  return (
    <Select
      value={optimistic ?? stageId}
      disabled={pending || stages.length === 0}
      onValueChange={(next) => {
        if (next === stageId) return;
        setOptimistic(next);
        start(async () => {
          const r = await setLeadStage({ id: leadId, stageId: next });
          setOptimistic(null); // reconcile with the server value
          if (!r.ok) toast.error(r.error);
          else toast.success(`Stage: ${byId.get(next)?.name ?? "updated"}`);
          onChanged();
        });
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Change stage"
        className={cn(
          "gap-1.5 py-0 pr-1.5 pl-2 text-xs font-medium data-[size=sm]:h-6 data-[size=sm]:rounded-full [&>svg:last-child]:size-3 [&>svg:last-child]:text-current [&>svg:last-child]:opacity-70",
          shown ? STAGE_BADGE[shown.color] : "text-muted-foreground",
          className,
        )}
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3 shrink-0" aria-hidden />}
        <span>{shown?.name ?? "Stage"}</span>
      </SelectTrigger>
      <SelectContent>
        {/* An archived current stage stays visible so the select shows it. */}
        {current?.archived_at ? <SelectItem value={current.id} disabled>{current.name}</SelectItem> : null}
        {stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
