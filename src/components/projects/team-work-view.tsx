"use client";

import { useState } from "react";
import Link from "next/link";
import { FileUp, History, Search } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { ClearFiltersButton } from "@/components/common/clear-filters-button";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { LateBadge, PhaseStatusBadge } from "@/components/projects/project-badges";
import { describeProjectActivity } from "@/components/projects/project-activity";
import { useProfile } from "@/components/providers/profile-provider";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { roleLabel, type AppRole } from "@/lib/constants";
import { fetchTeamWork } from "@/lib/project-queries";
import type { TeamPerson } from "@/lib/projects";
import { formatCalendarDate, formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

const TABLES = ["project_phases", "project_activities", "project_members", "project_file_events", "projects"];
const PERIODS = [7, 30] as const;
const SHOWS = { all: "Everyone", late: "Late", changes: "Changes requested", review: "Waiting for review" } as const;
type Show = keyof typeof SHOWS;

const FILE_TEXT: Record<string, string> = { uploaded: "Uploaded", submitted: "Sent for review", approved: "Approved", changes_requested: "Asked for changes on" };

/**
 * What the people on your projects are doing: each person's open phases (late first, then changes
 * requested, in progress, in review) and their latest actions. Admins see every project's team.
 */
export function TeamWorkView() {
  const me = useProfile();
  const { params, set } = useUrlState();
  const days = Number(params.get("days")) === 30 ? 30 : 7;
  const raw = params.get("show");
  const show: Show = raw && raw in SHOWS ? (raw as Show) : "all";
  const [search, setSearch] = useState("");
  const q = useLiveQuery({ queryKey: `team-work:${me.id}:${days}`, fetcher: (s) => fetchTeamWork(days, s), tables: TABLES });

  const needle = search.trim().toLowerCase();
  const people = (q.data?.people ?? []).filter((p) =>
    (!needle || p.name.toLowerCase().includes(needle) || p.projects.some((x) => x.name.toLowerCase().includes(needle)))
    && (show === "all" || (show === "late" ? p.late > 0 : show === "changes" ? p.changes > 0 : p.in_review > 0)));
  const totals = (q.data?.people ?? []).reduce((t, p) => ({ late: t.late + p.late, changes: t.changes + p.changes, review: t.review + p.in_review }), { late: 0, changes: 0, review: 0 });

  return (
    <>
      <PageHeader title="Team" description={me.roles.includes("admin") ? "What everyone on the projects is working on, and what they did lately." : "What the people on your projects are working on, and what they did lately."} />
      <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="pl-8" placeholder="Find a person or project" value={search} maxLength={100} onChange={(e) => setSearch(e.target.value)} aria-label="Find a person or project" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented label="Show" value={show} options={(Object.keys(SHOWS) as Show[]).map((k) => [k, `${SHOWS[k]}${k === "late" && totals.late ? ` (${totals.late})` : k === "changes" && totals.changes ? ` (${totals.changes})` : k === "review" && totals.review ? ` (${totals.review})` : ""}`])}
            onChange={(v) => set({ show: v === "all" ? null : v })} />
          <Segmented label="Period" value={String(days)} options={PERIODS.map((d) => [String(d), `Last ${d} days`])} onChange={(v) => set({ days: v === "7" ? null : v })} />
          <ClearFiltersButton loading={q.isFetching && !q.isInitialLoading} show={!!(needle || show !== "all" || days !== 7)} onClear={() => { setSearch(""); set({ show: null, days: null }); }} />
        </div>
      </div>

      {q.error && !q.data ? <ErrorState message={q.error} onRetry={q.refetch} /> : !q.data ? <ListSkeleton rows={4} /> : !q.data.people.length ? (
        <EmptyState title="No one on your projects yet" description="People appear here once they're added to a project team." />
      ) : !people.length ? <EmptyState title="Nobody matches" description="Change the search or what to show." /> : (
        <div className="grid gap-4 xl:grid-cols-2">
          {people.map((p) => <PersonCard key={p.id} p={p} days={days} />)}
        </div>
      )}
    </>
  );
}

function Segmented({ label, value, options, onChange }: { label: string; value: string; options: (readonly [string, string])[]; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border p-0.5" role="tablist" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="tab" aria-selected={v === value} onClick={() => onChange(v)}
          className={cn("rounded-md px-2.5 py-1 text-sm", v === value ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>{text}</button>
      ))}
    </div>
  );
}

function Count({ n, label, tone }: { n: number; label: string; tone?: "bad" | "warn" | "info" | "good" }) {
  return (
    <span className={cn("rounded-md border px-2 py-0.5 text-xs tabular-nums",
      !n ? "text-muted-foreground/70" : tone === "bad" ? "border-red-400/40 text-red-300" : tone === "warn" ? "border-orange-400/40 text-orange-300"
        : tone === "info" ? "border-violet-400/40 text-violet-300" : tone === "good" ? "border-emerald-400/40 text-emerald-300" : "border-sky-400/40 text-sky-300")}>
      <span className="font-semibold">{n}</span> {label}
    </span>
  );
}

function PersonCard({ p, days }: { p: TeamPerson; days: number }) {
  const me = useProfile();
  const [all, setAll] = useState(false);
  const phases = all ? p.phases : p.phases.slice(0, 5);
  return (
    <Card className={cn("gap-0 py-0", p.late && "border-red-400/30")}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold" aria-hidden>
            {p.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{p.name}</div>
            <div className="text-xs text-muted-foreground">
              {p.roles.map((r) => roleLabel(r as AppRole, me.features)).join(" · ")}
              {p.last_active ? ` · active ${formatRelative(p.last_active)}` : ` · nothing in the last ${days} days`}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Count n={p.late} label="late" tone="bad" />
          <Count n={p.changes} label="changes requested" tone="warn" />
          <Count n={p.in_progress} label="in progress" />
          <Count n={p.in_review} label="in review" tone="info" />
          <Count n={p.submitted} label={`sent for review (${days}d)`} tone="info" />
          <Count n={p.approved} label={`approved (${days}d)`} tone="good" />
        </div>

        {p.projects.length ? (
          <div className="flex flex-wrap gap-1.5 text-xs">
            {p.projects.map((x) => (
              <Link key={`${x.id}:${x.role}`} href={`/projects/${x.id}`} className="rounded-md bg-muted/60 px-2 py-0.5 hover:bg-accent">{x.name}</Link>
            ))}
          </div>
        ) : null}

        <section aria-label={`${p.name}'s open phases`}>
          <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Working on</h3>
          {!p.phases.length ? <p className="text-sm text-muted-foreground">No open phases.</p> : (
            <ul className="divide-y rounded-lg border">
              {phases.map((ph) => (
                <li key={ph.id}>
                  <Link href={`/projects/${ph.project_id}?tab=timeline&view=sheet`} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 hover:bg-accent/30">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{ph.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{ph.project} · {ph.stage} · due {formatCalendarDate(ph.deadline)}</span>
                    </span>
                    <PhaseStatusBadge status={ph.status} />
                    {ph.late_days > 0 ? <LateBadge days={ph.late_days} /> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {p.phases.length > 5 ? (
            <button type="button" className="mt-1 text-xs text-sky-300 hover:underline" onClick={() => setAll((a) => !a)}>
              {all ? "Show fewer" : `Show all ${p.phases.length}`}
            </button>
          ) : null}
        </section>

        <section aria-label={`What ${p.name} did lately`}>
          <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Lately</h3>
          {!p.recent.length ? <p className="text-sm text-muted-foreground">Nothing in the last {days} days.</p> : (
            <ol className="space-y-1.5">
              {p.recent.map((r, i) => {
                const text = r.source === "file"
                  ? { title: `${FILE_TEXT[r.type] ?? r.type} ${r.file ?? "a file"}`, detail: r.body }
                  : describeProjectActivity({ id: String(i), type: r.type, meta: r.meta, body: r.body, phase_id: null, created_at: r.at, actor: null });
                const Icon = r.source === "file" ? FileUp : History;
                return (
                  <li key={i} className="flex gap-2 text-sm">
                    <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block">{text.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        <Link href={`/projects/${r.project_id}`} className="hover:underline">{r.project}</Link> · {formatRelative(r.at)}{text.detail ? ` · ${text.detail}` : ""}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
