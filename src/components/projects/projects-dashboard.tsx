"use client";

import Link from "next/link";
import { AlertTriangle, FolderKanban, Hand, IndianRupee } from "lucide-react";
import { ErrorState, ListSkeleton } from "@/components/common/states";
import { Bars, ChartCard, Donut, StatCard } from "@/components/dashboard/widgets";
import { useProfile } from "@/components/providers/profile-provider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLiveQuery } from "@/hooks/use-live-query";
import { roleLabel, type AppRole } from "@/lib/constants";
import { formatCount, formatINR } from "@/lib/format";
import { PROJECT_TABLES } from "@/lib/permissions";
import { fetchProjectsDashboard } from "@/lib/project-queries";
import { cn } from "@/lib/utils";

const TABLES = [...PROJECT_TABLES, "leads"];

/** Star Gardens overview: what's late, what's due, money in, and who is on what (team board). */
export function ProjectsDashboard() {
  const me = useProfile();
  const q = useLiveQuery({ queryKey: `projects-dashboard:${me.id}`, fetcher: fetchProjectsDashboard, tables: TABLES });
  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.refetch} />;
  if (!q.data) return <ListSkeleton rows={4} />;
  const { cards: c, timeliness: t, by_stage, team } = q.data;
  return (
    <section className="space-y-4" aria-label="Projects">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Projects</h2>
        <Link href="/projects" className="text-sm text-muted-foreground hover:text-foreground">All projects →</Link>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active projects" value={formatCount(c.active_projects)} hint={c.on_hold ? `${c.on_hold} on hold` : "None on hold"} icon={<FolderKanban className="size-4" />} />
        <StatCard label="Late phases" value={formatCount(c.late_phases)} hint={c.late_phases ? `in ${c.late_projects} project${c.late_projects === 1 ? "" : "s"} · ${c.due_this_week} due this week` : `${c.due_this_week} due this week`}
          tone={c.late_phases ? "danger" : "success"} icon={<AlertTriangle className="size-4" />} />
        {c.collected_month != null ? (
          <StatCard label="Collected this month" value={formatINR(c.collected_month)} hint={c.overdue_amount ? `${formatINR(c.overdue_amount)} overdue` : "Nothing overdue"}
            tone={c.overdue_amount ? "danger" : undefined} icon={<IndianRupee className="size-4" />} />
        ) : null}
        <StatCard label="Leads waiting for a project" value={formatCount(c.handoffs_waiting)} hint="Handed over by BDMs" icon={<Hand className="size-4" />} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Phases on time" description="Submitted phases by timeliness, and open phases now (all open projects).">
          <Donut totalLabel="phases" items={[
            { name: "Submitted on time", value: t.on_time, color: "#34d399" },
            { name: "Submitted late", value: t.late_done, color: "#fbbf24" },
            { name: "Open, late now", value: t.late_open, color: "#f87171" },
            { name: "Open, on track", value: t.open_on_track, color: "#60a5fa" },
          ]} />
        </ChartCard>
        <ChartCard title="Projects by current stage" description="Where each open project is right now (its earliest unfinished phase).">
          {by_stage.length ? <Bars items={by_stage.map((s) => ({ name: s.name, value: s.count }))} label="Projects" horizontal height={Math.max(160, by_stage.length * 44)} />
            : <p className="text-sm text-muted-foreground">No open projects.</p>}
        </ChartCard>
      </div>
      <Card className="gap-0">
        <CardHeader className="pb-3"><CardTitle className="text-base">Team board</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {!team.length ? <p className="text-sm text-muted-foreground">Give people BDM, architect manager, designer or execution roles in Users.</p> : (
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="py-2 pr-3 font-medium">Person</th><th className="py-2 pr-3 font-medium">Working on</th><th className="w-28 py-2 font-medium">Phases</th></tr></thead>
              <tbody>
                {team.map((p) => (
                  <tr key={p.id} className="border-b align-top last:border-0">
                    <td className="py-2.5 pr-3">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">{p.roles.map((r) => roleLabel(r as AppRole, me.features)).join(" · ")}</div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-wrap gap-1.5">
                        {p.projects.map((x) => (
                          <Link key={`${x.id}:${x.role}`} href={`/projects/${x.id}`} className={cn("rounded-md border px-2 py-1 text-xs hover:bg-accent/40", x.late && "border-red-400/50")}>
                            <span className="font-medium">{x.name}</span>
                            <span className={cn("ml-1", x.late ? "text-red-300" : "text-muted-foreground")}>{x.phase ? `· ${x.stage}: ${x.phase}${x.late ? " (late)" : ""}` : "· all done"}</span>
                          </Link>
                        ))}
                        {(p.leads ?? []).map((l) => (
                          <span key={l.stage} className="rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">{l.stage}: {l.count} lead{l.count === 1 ? "" : "s"}</span>
                        ))}
                        {!p.projects.length && !(p.leads ?? []).length ? <span className="text-xs text-muted-foreground">Free</span> : null}
                      </div>
                    </td>
                    <td className="py-2.5 text-xs tabular-nums">{p.open_phases} open{p.late_phases ? <span className="ml-1 text-red-300">· {p.late_phases} late</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
