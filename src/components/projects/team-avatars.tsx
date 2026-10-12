import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { initials } from "@/lib/format";
import { MEMBER_ROLE_LABELS, type ProjectMember } from "@/lib/projects";

/** Overlapping initials of the project team; hover/focus shows name and role. */
export function TeamAvatars({ team, max = 4 }: { team: ProjectMember[]; max?: number }) {
  if (!team.length) return <span className="text-xs text-muted-foreground">No team yet</span>;
  const shown = team.slice(0, max);
  return (
    <div className="flex -space-x-1.5" aria-label={team.map((m) => `${m.display_name} (${MEMBER_ROLE_LABELS[m.role]})`).join(", ")}>
      {shown.map((m) => (
        <Tooltip key={`${m.id}:${m.role}`}>
          <TooltipTrigger asChild>
            <Avatar className="size-7 border-2 border-background">
              <AvatarFallback className="text-[10px]">{initials(m.display_name)}</AvatarFallback>
            </Avatar>
          </TooltipTrigger>
          <TooltipContent>{m.display_name} · {MEMBER_ROLE_LABELS[m.role]}</TooltipContent>
        </Tooltip>
      ))}
      {team.length > max ? (
        <Avatar className="size-7 border-2 border-background"><AvatarFallback className="text-[10px]">+{team.length - max}</AvatarFallback></Avatar>
      ) : null}
    </div>
  );
}
