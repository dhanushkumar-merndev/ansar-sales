import { CalendarCheck, CalendarClock, ShieldCheck } from "lucide-react";
import { LateBadge, PhaseStatusBadge } from "@/components/projects/project-badges";
import type { Phase } from "@/lib/projects";
import { STAGE_HEX, type StageColor } from "@/lib/stages";
import { formatCalendarDate } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * The project's phases as a numbered vertical process (Star Gardens poster style): big step
 * number in the phase colour, what happens, dates, and where it stands. Easy to read at a glance,
 * and used in the client portal too (pass `client` to hide owners and remarks).
 */
export function MilestoneStrip({ phases, client = false, onOpen }: { phases: Phase[]; client?: boolean; onOpen?: (p: Phase) => void }) {
  if (!phases.length) return <p className="text-sm text-muted-foreground">No phases yet.</p>;
  return (
    <ol className="space-y-2.5">
      {phases.map((p, i) => {
        const hex = STAGE_HEX[p.color as StageColor] ?? STAGE_HEX.slate;
        const finished = p.status === "done" || p.status === "skipped";
        const Inner = onOpen ? "button" : "div";
        return (
          <li key={p.id}>
            <Inner
              {...(onOpen ? { type: "button" as const, onClick: () => onOpen(p) } : {})}
              className={cn("flex w-full items-stretch overflow-hidden rounded-xl border bg-card text-left", onOpen && "transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring",
                p.overdue && "border-red-400/40")}
            >
              <div className="flex w-14 shrink-0 items-center justify-center text-xl font-semibold tabular-nums sm:w-16 sm:text-2xl"
                style={{ background: `${hex}${finished ? "33" : "22"}`, color: hex }}>
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="min-w-0 flex-1 space-y-1.5 px-3 py-2.5 sm:px-4">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={cn("font-medium", finished && "text-muted-foreground line-through decoration-1")}>{p.name}</span>
                  <span className="text-xs uppercase tracking-wide text-muted-foreground">{p.category}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><CalendarClock className="size-3.5" />
                    {formatCalendarDate(p.planned_start)} → {formatCalendarDate(p.deadline)}
                  </span>
                  {p.submitted_on ? <span className="inline-flex items-center gap-1"><CalendarCheck className="size-3.5" />Submitted {formatCalendarDate(p.submitted_on)}</span> : null}
                  {p.needs_client_approval ? <span className="inline-flex items-center gap-1"><ShieldCheck className="size-3.5" />Client approval</span> : null}
                  {!client && p.owner ? <span>· {p.owner.display_name}</span> : null}
                </div>
                {p.items.length ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <div className="h-1 w-24 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full" style={{ width: `${(p.items.filter((x) => x.done_at).length / p.items.length) * 100}%`, background: hex }} />
                    </div>
                    {p.items.filter((x) => x.done_at).length}/{p.items.length} items
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col items-end justify-center gap-1 px-3">
                <PhaseStatusBadge status={p.status} />
                <LateBadge days={p.late_days} submitted={p.status === "in_review" || p.status === "done"} />
              </div>
            </Inner>
          </li>
        );
      })}
    </ol>
  );
}
