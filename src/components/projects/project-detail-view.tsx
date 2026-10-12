"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, CalendarRange, IndianRupee, Mail, MapPin, Pencil, Phone, Timer } from "lucide-react";
import { ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { MilestoneStrip } from "@/components/projects/milestone-strip";
import { BoqCard } from "@/components/projects/execution/boq-card";
import { ProjectFilesTab } from "@/components/projects/files/project-files-tab";
import { ClientAccessCard } from "@/components/projects/portal/client-access-card";
import { SiteLogsCard, SnagsCard } from "@/components/projects/execution/site-work-cards";
import { ProjectPaymentsTab } from "@/components/projects/payments/project-payments-tab";
import { SiteVisitsList } from "@/components/projects/site-visits/site-visits-list";
import { ProjectActivityCard } from "@/components/projects/project-activity";
import { ExtendedBadge, LateBadge, ProjectStatusBadge } from "@/components/projects/project-badges";
import { EditProjectDialog, FinancialsDialog, TeamEditor } from "@/components/projects/project-dialogs";
import { PhaseDrawer } from "@/components/projects/timeline/phase-drawer";
import { ProjectTimelineTab } from "@/components/projects/timeline/project-timeline-tab";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { formatINR } from "@/lib/format";
import { PROJECT_TABLES } from "@/lib/permissions";
import { fetchProjectDetail } from "@/lib/project-queries";
import { daysBetween, isPhaseFinished, type Phase } from "@/lib/projects";
import { formatCalendarDate, istToday } from "@/lib/time";

const TABS = { overview: "Overview", timeline: "Timeline", files: "Files", visits: "Site visits", boq: "BOQ", execution: "Execution", payments: "Payments", activity: "Activity" } as const;
type Tab = keyof typeof TABS;
const TABLES = [...PROJECT_TABLES];

export function ProjectDetailView({ projectId }: { projectId: string }) {
  const me = useProfile();
  const { params, set } = useUrlState();
  const raw = params.get("tab");
  const requested: Tab = raw && raw in TABS ? (raw as Tab) : "overview";
  const detail = useLiveQuery({
    queryKey: `project:${me.id}:${projectId}`,
    fetcher: (s) => fetchProjectDetail(projectId, s),
    tables: TABLES,
  });
  const [editing, setEditing] = useState(false);
  const [money, setMoney] = useState(false);
  const [openPhase, setOpenPhase] = useState<string | null>(null);

  if (detail.error && !detail.data) return <ErrorState message={detail.error} onRetry={detail.refetch} />;
  if (!detail.data) return <ListSkeleton rows={6} />;
  const { project: p, financials, members, phases, can, lead } = detail.data;
  const today = istToday();
  const open = phases.filter((ph) => !isPhaseFinished(ph.status));
  const maxLate = Math.max(0, ...open.map((ph) => ph.late_days));
  const done = phases.length - open.length;
  const daysLeft = daysBetween(today, p.end_date);
  const current = open.slice().sort((a, b) => a.planned_start.localeCompare(b.planned_start) || a.position - b.position)[0];
  const phase = phases.find((ph) => ph.id === openPhase) ?? null;
  // Money (payments) is Admin and Accounts only; the team (admin + members) sees design and site work.
  const team = can.admin || members.some((m) => m.id === me.id);
  const tabs = (Object.keys(TABS) as Tab[]).filter((t) => (t === "payments" ? can.money : t === "boq" || t === "execution" || t === "visits" ? team : true));
  const tab = tabs.includes(requested) ? requested : "overview";

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Link href="/projects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Projects</Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{p.name}</h1>
              <ProjectStatusBadge status={p.status} />
              <LateBadge days={maxLate} />
              <ExtendedBadge original={p.original_end_date} end={p.end_date} />
              <FetchingIndicator show={detail.isFetching} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {p.code} · {p.client_name}{lead ? <> · from lead <Link className="underline underline-offset-2" href={`/leads/${lead.id}`}>{lead.name}</Link> ({lead.owner})</> : null}
            </p>
          </div>
          {can.manage ? <Button variant="outline" onClick={() => setEditing(true)}><Pencil /> Edit</Button> : null}
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => set({ tab: v === "overview" ? null : v })}>
        <TabsList>{tabs.map((t) => <TabsTrigger key={t} value={t}>{TABS[t]}</TabsTrigger>)}</TabsList>
      </Tabs>

      {tab === "timeline" ? (
        <ProjectTimelineTab detail={detail.data} onChanged={detail.refetch} onOpenPhase={(ph: Phase) => setOpenPhase(ph.id)} />
      ) : tab === "files" ? (
        <ProjectFilesTab detail={detail.data} />
      ) : tab === "visits" ? (
        <SiteVisitsList projectId={p.id} canSchedule={can.manage} scheduleTitle={`${p.name} · ${p.site_address ?? "site"}`} />
      ) : tab === "boq" ? (
        <BoqCard detail={detail.data} />
      ) : tab === "execution" ? (
        <div className="grid gap-5 xl:grid-cols-2"><SiteLogsCard detail={detail.data} /><SnagsCard detail={detail.data} /></div>
      ) : tab === "payments" ? (
        <ProjectPaymentsTab detail={detail.data} />
      ) : tab === "activity" ? (
        <ProjectActivityCard projectId={projectId} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Summary icon={CalendarRange} label="Dates" value={`${formatCalendarDate(p.start_date)} – ${formatCalendarDate(p.end_date)}${p.original_end_date && p.original_end_date !== p.end_date ? ` (planned ${formatCalendarDate(p.original_end_date)})` : ""}`}
                hint={p.status === "completed" && p.completed_on ? `Completed ${formatCalendarDate(p.completed_on)}` : daysLeft >= 0 ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : `${-daysLeft} days past the end date`}
                tone={p.status !== "completed" && daysLeft < 0 ? "bad" : undefined} />
              <Summary icon={Timer} label="Progress" value={`${done}/${phases.length} phases`}
                hint={maxLate ? `${open.filter((x) => x.overdue).length} late, worst by ${maxLate} days` : "Nothing late"} tone={maxLate ? "bad" : "good"} />
              <Summary icon={MapPin} label="Current phase" value={current?.name ?? (phases.length ? "All finished" : "—")}
                hint={current ? `Deadline ${formatCalendarDate(current.deadline)}` : undefined} />
              {can.money ? (
                <button type="button" className="text-left" onClick={() => setMoney(true)}>
                  <Summary icon={IndianRupee} label="Contract value" value={financials?.contract_value != null ? formatINR(financials.contract_value) : "Not set"}
                    hint={financials?.area_sqft ? `${financials.area_sqft} sq ft${financials.rate_per_sqft != null ? ` × ${formatINR(financials.rate_per_sqft)}` : ""}` : "Tap to set"} />
                </button>
              ) : null}
            </div>
            <Card className="gap-0">
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-base">Project process</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => set({ tab: "timeline" })}>Open timeline</Button>
              </CardHeader>
              <CardContent><MilestoneStrip phases={phases} onOpen={(ph) => setOpenPhase(ph.id)} /></CardContent>
            </Card>
          </div>
          <div className="space-y-5">
            <Card className="gap-0">
              <CardHeader className="pb-3"><CardTitle className="text-base">Team</CardTitle></CardHeader>
              <CardContent><TeamEditor projectId={p.id} members={members} canManage={can.manage} isAdmin={can.admin} onChanged={detail.refetch} /></CardContent>
            </Card>
            {can.manage ? <ClientAccessCard projectId={p.id} clientName={p.client_name} /> : null}
            <Card className="gap-0">
              <CardHeader className="pb-3"><CardTitle className="text-base">Client & site</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="font-medium">{p.client_name}</div>
                {p.client_phone ? <a href={`tel:${p.client_phone.replace(/\s/g, "")}`} className="flex items-center gap-2 hover:underline"><Phone className="size-4 text-muted-foreground" />{p.client_phone}</a> : null}
                {p.client_email ? <a href={`mailto:${p.client_email}`} className="flex items-center gap-2 hover:underline"><Mail className="size-4 text-muted-foreground" />{p.client_email}</a> : null}
                <div className="flex items-start gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{p.site_address ?? <span className="text-muted-foreground">No site address yet</span>}
                    {p.site_lat != null && p.site_lng != null ? (
                      <a className="ml-1 underline underline-offset-2" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${p.site_lat},${p.site_lng}`}>Open map</a>
                    ) : null}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {can.manage ? <EditProjectDialog project={p} open={editing} onOpenChange={setEditing} onDone={detail.refetch} /> : null}
      {can.money ? <FinancialsDialog projectId={p.id} financials={financials} open={money} onOpenChange={setMoney} onDone={detail.refetch} /> : null}
      <PhaseDrawer phase={phase} detail={detail.data} onClose={() => setOpenPhase(null)} onChanged={detail.refetch} />
    </div>
  );
}

function Summary({ icon: Icon, label, value, hint, tone }: { icon: typeof Timer; label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <Card className="h-full gap-1 py-3">
      <CardContent className="space-y-1 px-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon className="size-3.5" />{label}</div>
        <div className="truncate font-semibold">{value}</div>
        {hint ? <div className={tone === "bad" ? "text-xs text-red-400" : tone === "good" ? "text-xs text-emerald-400" : "text-xs text-muted-foreground"}>{hint}</div> : null}
      </CardContent>
    </Card>
  );
}
