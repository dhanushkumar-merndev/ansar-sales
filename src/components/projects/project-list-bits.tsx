"use client";

import { LateBadge, PhaseStatusBadge } from "@/components/projects/project-badges";
import type { ProjectListItem } from "@/lib/projects";
import { formatCalendarDate } from "@/lib/time";
import { cn } from "@/lib/utils";

// Pieces shared by the projects list and the project folders.

export function CurrentPhase({ p }: { p: ProjectListItem }) {
  if (!p.current_phase) return <span className="text-sm text-muted-foreground">{p.phases_total ? "All phases finished" : "No phases yet"}</span>;
  return (
    <div className="space-y-1">
      <div className="truncate text-sm">{p.current_phase.name}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <PhaseStatusBadge status={p.current_phase.status} />
        <span className="text-xs text-muted-foreground">deadline {formatCalendarDate(p.current_phase.deadline)}</span>
      </div>
    </div>
  );
}

export function Progress({ p }: { p: ProjectListItem }) {
  const pct = p.phases_total ? Math.round((p.phases_done / p.phases_total) * 100) : 0;
  return (
    <div className="min-w-[140px] space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="tabular-nums">{p.phases_done}/{p.phases_total} phases</span>
        <span className="tabular-nums text-muted-foreground">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${pct}% of phases finished`}>
        <div className={cn("h-full rounded-full", p.late_phases ? "bg-red-400" : "bg-emerald-400")} style={{ width: `${pct}%` }} />
      </div>
      {p.late_phases ? <LateBadge days={p.max_late_days} /> : null}
    </div>
  );
}
