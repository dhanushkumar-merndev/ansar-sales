import { AlertTriangle, CalendarPlus, Check, CircleDashed, CircleDot, Eye, PauseCircle, RotateCcw, SkipForward, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { daysBetween, PHASE_STATUS_LABELS, PROJECT_STATUS_LABELS, type PhaseStatus, type ProjectStatus } from "@/lib/projects";
import { formatCalendarDate } from "@/lib/time";
import { STAGE_BADGE, STAGE_HEX, type StageColor } from "@/lib/stages";
import { cn } from "@/lib/utils";

const PROJECT_STATUS_STYLE: Record<ProjectStatus, { color: StageColor; icon: typeof Check }> = {
  active: { color: "sky", icon: CircleDot },
  on_hold: { color: "amber", icon: PauseCircle },
  completed: { color: "emerald", icon: Check },
  cancelled: { color: "slate", icon: X },
};

export function ProjectStatusBadge({ status, className }: { status: ProjectStatus; className?: string }) {
  const s = PROJECT_STATUS_STYLE[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", STAGE_BADGE[s.color], className)}>
      <s.icon className="size-3" aria-hidden />{PROJECT_STATUS_LABELS[status]}
    </Badge>
  );
}

const PHASE_STATUS_STYLE: Record<PhaseStatus, { color: StageColor; icon: typeof Check }> = {
  not_started: { color: "slate", icon: CircleDashed },
  in_progress: { color: "sky", icon: CircleDot },
  in_review: { color: "violet", icon: Eye },
  changes_requested: { color: "orange", icon: RotateCcw },
  done: { color: "emerald", icon: Check },
  skipped: { color: "slate", icon: SkipForward },
};

export function PhaseStatusBadge({ status, className }: { status: PhaseStatus; className?: string }) {
  const s = PHASE_STATUS_STYLE[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", STAGE_BADGE[s.color], status === "skipped" && "opacity-70", className)}>
      <s.icon className="size-3" aria-hidden />{PHASE_STATUS_LABELS[status]}
    </Badge>
  );
}

/** Red "N days late" (open and past the deadline) or amber "Submitted N days late". */
/** "Extended 15 days" (or "Brought forward") when the end date moved from the one the project was created with. */
export function ExtendedBadge({ original, end, className }: { original?: string; end: string; className?: string }) {
  if (!original || original === end) return null;
  const days = daysBetween(original, end);
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", days > 0 ? STAGE_BADGE.amber : STAGE_BADGE.sky, className)}
      title={`Planned end was ${formatCalendarDate(original)}`}>
      <CalendarPlus className="size-3" aria-hidden />
      {days > 0 ? `Extended ${days} day${days === 1 ? "" : "s"}` : `Brought forward ${-days} day${days === -1 ? "" : "s"}`}
    </Badge>
  );
}

export function LateBadge({ days, submitted, className }: { days: number; submitted?: boolean; className?: string }) {
  if (days <= 0) return null;
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", submitted ? STAGE_BADGE.amber : STAGE_BADGE.red, className)}>
      <AlertTriangle className="size-3" aria-hidden />
      {submitted ? `Submitted ${days}d late` : `${days} day${days === 1 ? "" : "s"} late`}
    </Badge>
  );
}

export function ColorDot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-full", className)} style={{ background: STAGE_HEX[color as StageColor] ?? STAGE_HEX.slate }} />;
}
