import { AlertTriangle, Check, CircleDashed, Clock, Hourglass } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { MILESTONE_STATUS_LABELS, type MilestoneStatus } from "@/lib/projects";
import { STAGE_BADGE, type StageColor } from "@/lib/stages";
import { cn } from "@/lib/utils";

const STYLE: Record<MilestoneStatus, { color: StageColor; icon: typeof Check }> = {
  upcoming: { color: "slate", icon: CircleDashed }, due: { color: "amber", icon: Clock }, partly_paid: { color: "sky", icon: Hourglass },
  overdue: { color: "red", icon: AlertTriangle }, paid: { color: "emerald", icon: Check },
};

export function MilestoneBadge({ status, days, className }: { status: MilestoneStatus; days?: number; className?: string }) {
  const s = STYLE[status];
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", STAGE_BADGE[s.color], className)}>
      <s.icon className="size-3" aria-hidden />{MILESTONE_STATUS_LABELS[status]}{status === "overdue" && days ? ` · ${days}d` : ""}
    </Badge>
  );
}
