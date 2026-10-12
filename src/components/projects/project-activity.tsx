"use client";

import { useState, useTransition } from "react";
import {
  CalendarClock, CircleDot, FolderPlus, Loader2, MessageSquare, Pencil, Plus, Send, Trash2, UserMinus, UserPlus, UserRoundCog, type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { ScrollBox } from "@/components/common/scroll-box";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { formatINR } from "@/lib/format";
import { fetchProjectActivities } from "@/lib/project-queries";
import { daysBetween, MEMBER_ROLE_LABELS, PHASE_STATUS_LABELS, PROJECT_STATUS_LABELS, type PhaseStatus, type ProjectActivity, type ProjectMemberRole, type ProjectStatus } from "@/lib/projects";
import { formatCalendarDate, formatDateTime, formatRelative } from "@/lib/time";
import { addProjectNote } from "@/server/actions/projects";

const PAGE = 30;

const ICONS: Record<string, LucideIcon> = {
  project_created: FolderPlus, project_updated: Pencil, status_changed: CircleDot, member_added: UserPlus, member_removed: UserMinus,
  note: MessageSquare, phase_added: Plus, phase_updated: Pencil, phase_rescheduled: CalendarClock, phase_status_changed: CircleDot,
  phase_owner_changed: UserRoundCog, phase_removed: Trash2,
};

type Meta = Record<string, unknown>;
const s = (v: unknown) => (v == null || v === "" ? "—" : String(v));
const d = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatCalendarDate(v) : s(v));

function changesText(changes: unknown) {
  if (!changes || typeof changes !== "object") return null;
  return Object.entries(changes as Record<string, { from: unknown; to: unknown }>)
    .map(([k, v]) => `${k}: ${k === "Contract value" ? (v.from == null ? "—" : formatINR(v.from as number)) : d(v.from)} → ${k === "Contract value" ? (v.to == null ? "—" : formatINR(v.to as number)) : d(v.to)}`)
    .join(" · ");
}

/** Readable title and detail for a project event (never raw JSON). */
export function describeProjectActivity(a: ProjectActivity): { title: string; detail: string | null } {
  const m = a.meta as Meta;
  switch (a.type) {
    case "project_created": return { title: "Project created", detail: `${d(m.start)} → ${d(m.end)}${m.phases ? ` · ${m.phases} phases` : ""}` };
    case "project_updated": {
      // An end-date move is the change people look for: say it in words.
      const end = (m.changes as Record<string, { from: unknown; to: unknown }> | undefined)?.End;
      if (end && typeof end.from === "string" && typeof end.to === "string") {
        const days = daysBetween(end.from, end.to);
        return { title: days > 0 ? `End date extended by ${days} day${days === 1 ? "" : "s"}` : `End date brought forward by ${-days} day${days === -1 ? "" : "s"}`, detail: changesText(m.changes) };
      }
      return { title: "Project details changed", detail: changesText(m.changes) };
    }
    case "status_changed": return { title: `Project ${PROJECT_STATUS_LABELS[m.to as ProjectStatus]?.toLowerCase() ?? s(m.to)}`, detail: `was ${PROJECT_STATUS_LABELS[m.from as ProjectStatus] ?? s(m.from)}` };
    case "member_added": return { title: `${s(m.name)} joined the team`, detail: MEMBER_ROLE_LABELS[m.role as ProjectMemberRole] ?? null };
    case "member_removed": return { title: `${s(m.name)} left the team`, detail: MEMBER_ROLE_LABELS[m.role as ProjectMemberRole] ?? null };
    case "note": return { title: "Note", detail: a.body };
    case "phase_added": return { title: `Phase added: ${s(m.phase)}`, detail: m.deadline ? `${s(m.category)} · ${d(m.start)} → ${d(m.deadline)}` : s(m.category) };
    case "phase_removed": return { title: `Phase removed: ${s(m.phase)}`, detail: s(m.category) };
    case "phase_status_changed": {
      const to = PHASE_STATUS_LABELS[m.to as PhaseStatus] ?? s(m.to);
      const late = typeof m.submitted_on === "string" && typeof m.deadline === "string" && m.submitted_on > m.deadline;
      return { title: `${s(m.phase)}: ${to}`, detail: `was ${PHASE_STATUS_LABELS[m.from as PhaseStatus] ?? s(m.from)}${late ? ` · submitted after the ${d(m.deadline)} deadline` : ""}` };
    }
    case "phase_rescheduled": {
      const f = (m.from ?? {}) as Meta, t = (m.to ?? {}) as Meta;
      return { title: `${s(m.phase)} rescheduled`, detail: `${d(f.start)} – ${d(f.deadline)} → ${d(t.start)} – ${d(t.deadline)}` };
    }
    case "phase_owner_changed": return { title: `${s(m.phase)} assigned to ${m.to ? s(m.to) : "nobody"}`, detail: m.from ? `was ${s(m.from)}` : null };
    case "phase_updated": return { title: `${s(m.phase)} updated`, detail: changesText(m.changes) };
    default: return { title: a.type.replace(/_/g, " "), detail: null };
  }
}

export function ProjectActivityCard({ projectId }: { projectId: string }) {
  const me = useProfile();
  const [limit, setLimit] = useState(PAGE);
  const feed = useLiveQuery({
    queryKey: `project-activity:${me.id}:${projectId}:${limit}`,
    fetcher: (sig) => fetchProjectActivities(projectId, limit, sig),
    tables: ["project_activities"],
  });
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    const r = await addProjectNote({ projectId, body: note });
    if (!r.ok) return void toast.error(r.error);
    setNote("");
    toast.success("Note added");
    feed.refetch();
  });

  return (
    <Card className="gap-0">
      <CardHeader className="pb-3"><CardTitle className="text-base">Activity</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={5000} rows={2} placeholder="Add a note for the team…" aria-label="Project note" />
          <div className="flex justify-end">
            <Button size="sm" disabled={pending || !note.trim()} onClick={save}>{pending ? <Loader2 className="animate-spin" /> : <Send />} Add note</Button>
          </div>
        </div>
        {feed.error && !feed.data ? <ErrorState message={feed.error} onRetry={feed.refetch} /> : feed.isInitialLoading ? <ListSkeleton rows={4} /> : !feed.data?.items.length ? (
          <EmptyState title="No activity yet" />
        ) : (
          <ScrollBox label="Project activity" className="max-h-[560px]">
            <ol className="relative space-y-4 pl-8 before:absolute before:top-2 before:bottom-2 before:left-[13px] before:w-px before:bg-border">
              {feed.data.items.map((a) => {
                const Icon = ICONS[a.type] ?? CircleDot;
                const { title, detail } = describeProjectActivity(a);
                return (
                  <li key={a.id} className="relative">
                    <span className="absolute -left-8 flex size-7 items-center justify-center rounded-full border bg-card"><Icon className="size-3.5 text-muted-foreground" /></span>
                    <div className="text-sm font-medium">{title}</div>
                    {detail ? <div className="whitespace-pre-wrap text-sm text-muted-foreground">{detail}</div> : null}
                    <div className="mt-0.5 text-xs text-muted-foreground" title={formatDateTime(a.created_at)}>
                      {a.actor?.display_name ?? "System"} · {formatRelative(a.created_at)}
                    </div>
                  </li>
                );
              })}
            </ol>
            {feed.data.has_more ? (
              <div className="pt-3 text-center"><Button variant="ghost" size="sm" disabled={feed.isFetching} onClick={() => setLimit((l) => Math.min(l + PAGE, 100))}>Show older activity</Button></div>
            ) : null}
          </ScrollBox>
        )}
      </CardContent>
    </Card>
  );
}
