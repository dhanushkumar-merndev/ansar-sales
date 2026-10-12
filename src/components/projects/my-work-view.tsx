"use client";

import Link from "next/link";
import { AlertTriangle, ClipboardPen, Hammer, MapPin } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { LateBadge, PhaseStatusBadge } from "@/components/projects/project-badges";
import { useProfile } from "@/components/providers/profile-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLiveQuery } from "@/hooks/use-live-query";
import { PROJECT_TABLES } from "@/lib/permissions";
import { fetchMyWork } from "@/lib/project-queries";
import { daysBetween } from "@/lib/projects";
import { formatCalendarDate, formatDateTime, formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

const TABLES = [...PROJECT_TABLES];

/** Everything assigned to me across projects, most urgent first. */
export function MyWorkView() {
  const me = useProfile();
  const q = useLiveQuery({ queryKey: `my-work:${me.id}`, fetcher: fetchMyWork, tables: TABLES });
  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.refetch} />;
  const w = q.data;
  const late = w?.phases.filter((p) => p.overdue) ?? [];
  const soon = w?.phases.filter((p) => !p.overdue && daysBetween(w.today, p.deadline) <= 3) ?? [];
  const later = w?.phases.filter((p) => !p.overdue && daysBetween(w.today, p.deadline) > 3) ?? [];
  return (
    <>
      <PageHeader title="My work" description={w ? `${late.length} late, ${soon.length} due in the next 3 days, ${w.visits.length} visits planned.` : "Your phases, visits, sites and snags."} />
      {!w ? <ListSkeleton /> : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-5">
            <PhaseGroup title="Late" tone="bad" phases={late} today={w.today} />
            <PhaseGroup title="Due in the next 3 days" tone="warn" phases={soon} today={w.today} />
            <PhaseGroup title="Later" phases={later} today={w.today} />
            {!w.phases.length ? <EmptyState title="No phases assigned to you" description="Phases you own on any project show up here." /> : null}
          </div>
          <div className="space-y-5">
            {w.sites.length ? (
              <Card className="gap-0">
                <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><Hammer className="size-4" />My sites</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {w.sites.map((s) => (
                    <Link key={s.id} href={`/projects/${s.id}?tab=execution`} className="flex items-center gap-2 rounded-lg border p-3 hover:bg-accent/30">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{s.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{s.site_address ?? s.code}{s.open_snags ? ` · ${s.open_snags} open snags` : ""}</div>
                      </div>
                      {s.logged_today ? <span className="text-xs text-emerald-300">Logged today</span>
                        : <span className="inline-flex items-center gap-1 text-xs text-amber-300"><ClipboardPen className="size-3.5" />Log today</span>}
                    </Link>
                  ))}
                </CardContent>
              </Card>
            ) : null}
            <Card className="gap-0">
              <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><MapPin className="size-4" />My site visits</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {!w.visits.length ? <p className="text-sm text-muted-foreground">No visits planned.</p> : w.visits.map((v) => (
                  <Link key={v.id} href={v.project ? `/projects/${v.project.id}?tab=visits` : "/site-visits"} className={cn("block rounded-lg border p-3 hover:bg-accent/30", v.overdue && "border-red-400/40")}>
                    <div className="font-medium">{v.project?.name ?? v.lead?.name}</div>
                    <div className="text-xs text-muted-foreground">{formatDateTime(v.scheduled_at)} · {formatRelative(v.scheduled_at)} · {v.purpose}</div>
                  </Link>
                ))}
              </CardContent>
            </Card>
            {w.snags.length ? (
              <Card className="gap-0">
                <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="size-4" />Snags to fix</CardTitle></CardHeader>
                <CardContent>
                  <ul className="divide-y">
                    {w.snags.map((s) => (
                      <li key={s.id} className="py-2">
                        <Link href={`/projects/${s.project.id}?tab=execution`} className="text-sm hover:underline">{s.title}</Link>
                        <div className="text-xs text-muted-foreground">{s.project.name}{s.due_date ? ` · by ${formatCalendarDate(s.due_date)}` : ""}</div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function PhaseGroup({ title, phases, today, tone }: { title: string; phases: NonNullable<Awaited<ReturnType<typeof fetchMyWork>>>["phases"]; today: string; tone?: "bad" | "warn" }) {
  if (!phases.length) return null;
  return (
    <section>
      <h2 className={cn("mb-2 text-sm font-semibold", tone === "bad" ? "text-red-300" : tone === "warn" ? "text-amber-200" : "text-muted-foreground")}>{title} · {phases.length}</h2>
      <div className="space-y-2">
        {phases.map((p) => {
          const left = daysBetween(today, p.deadline);
          return (
            <Link key={p.id} href={`/projects/${p.project.id}?tab=timeline&view=sheet`} className="block">
              <Card className={cn("py-0 hover:bg-accent/30", p.overdue && "border-red-400/40")}>
                <CardContent className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">{p.project.name} · {p.project.code} · {p.category}</div>
                  </div>
                  <PhaseStatusBadge status={p.status} />
                  {p.overdue ? <LateBadge days={p.late_days} /> : <span className="text-sm tabular-nums text-muted-foreground">{left === 0 ? "Due today" : `${left} day${left === 1 ? "" : "s"} left`} · {formatCalendarDate(p.deadline)}</span>}
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
