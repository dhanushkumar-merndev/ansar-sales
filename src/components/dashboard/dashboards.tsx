"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowRight, Plus } from "lucide-react";
import { seriesColor } from "@/components/charts/chart";
import { pastPresets, RangePicker, type DayRange } from "@/components/common/range-picker";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { ChartCard, Bars, Donut, GroupedBars, StatCard, TrendLine } from "@/components/dashboard/widgets";
import type { FinanceSummary } from "@/components/finance/finance-view";
import { FollowUpList } from "@/components/follow-ups/follow-up-list";
import { LeadFormDialog } from "@/components/leads/lead-form-dialog";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLiveQuery } from "@/hooks/use-live-query";
import { categoryLabel } from "@/lib/constants";
import { formatCount, formatINR, formatINRCompact } from "@/lib/format";
import { fetchDashboard, fetchFollowUps } from "@/lib/queries";
import { stageHex } from "@/lib/stages";
import { addDays, formatCalendarDate, formatDayLabel, formatMonth, istToday } from "@/lib/time";

/** Leads per pipeline stage, in pipeline order (only stages that have leads). */
type StageCount = { id: string; name: string; kind: string; color: string; count: number };
type Cards = { active_leads: number; won_leads: number; lost_leads: number; today_pending: number; overdue: number };
type Range = { from: string; to: string; days: number };
type AdminData = {
  range: Range; cards: Cards; trend: { date: string; count: number }[]; stages: StageCount[];
  salespeople: { id: string; name: string; active: number; won: number; lost: number }[]; niches: { name: string; count: number }[];
};
type SalesData = { range: Range; cards: Cards; stages: StageCount[]; activity: { date: string; count: number }[] };

const rangeLabel = (r?: Range) => (r ? `${formatCalendarDate(r.from)} – ${formatCalendarDate(r.to)} (IST)` : "");
const winRate = (c?: Cards) => {
  if (!c) return null;
  const closed = c.won_leads + c.lost_leads;
  return closed === 0 ? "—" : `${Math.round((c.won_leads / closed) * 100)}%`;
};

/** Defaults to the last 30 IST days, like the old picker. */
function useDashRange() {
  return useState<DayRange>(() => ({ from: addDays(istToday(), -29), to: istToday() }));
}

function stageItems(stages: StageCount[]) {
  // Colour follows the stage's own colour, never its rank.
  return stages.map((s) => ({ name: s.name, value: s.count, color: stageHex(s.color) }));
}

export function AdminDashboard() {
  const [range, setRange] = useDashRange();
  const { data, error, isFetching, isInitialLoading, refetch } = useLiveQuery({
    queryKey: `dash-admin:${range.from}:${range.to}`,
    fetcher: (s) => fetchDashboard<AdminData>("dashboard_admin", range, s),
    tables: ["leads", "follow_ups"],
  });
  const dayLabel = useCallback((d: string) => formatDayLabel(d), []);
  const c = data?.cards;
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Team pipeline and follow-ups."
        actions={
          <>
            <FetchingIndicator show={isFetching && !isInitialLoading} />
            <RangePicker value={range} onChange={(r) => r && setRange(r)} presets={pastPresets()} ariaLabel="Dashboard date range" />
          </>
        }
      />
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Active leads" value={c ? formatCount(c.active_leads) : null} hint="Not won or lost" />
            <StatCard label="Follow-ups due today" value={c ? formatCount(c.today_pending) : null} hint="Pending, IST today" />
            <StatCard label="Overdue follow-ups" value={c ? formatCount(c.overdue) : null} tone={c?.overdue ? "danger" : undefined} hint="Pending and past due" />
            <StatCard label="Won leads" value={c ? formatCount(c.won_leads) : null} tone="success" hint={`Win rate (won ÷ closed): ${winRate(c) ?? "…"}`} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCard title="New leads" description={`Leads created per day · ${rangeLabel(data?.range)}`}>
              {data ? <TrendLine points={data.trend.map((p) => ({ x: p.date, y: p.count }))} label="New leads" dateLabel={dayLabel} /> : <ListSkeleton rows={4} />}
            </ChartCard>
            <ChartCard title="Current pipeline" description="All active (non-archived) leads by current status">
              {data ? <Donut items={stageItems(data.stages)} totalLabel="leads" /> : <ListSkeleton rows={4} />}
            </ChartCard>
            <ChartCard title="By salesperson" description="Current leads owned, by outcome">
              {data ? (data.salespeople.length ? (
                <GroupedBars
                  categories={data.salespeople.map((s) => s.name)}
                  series={[
                    { name: "Active", values: data.salespeople.map((s) => s.active) },
                    { name: "Won", values: data.salespeople.map((s) => s.won) },
                    { name: "Lost", values: data.salespeople.map((s) => s.lost) },
                  ]}
                />
              ) : <p className="py-10 text-center text-sm text-muted-foreground">No leads yet.</p>) : <ListSkeleton rows={4} />}
            </ChartCard>
            <ChartCard title="Top niches" description="Current leads per niche (top 8)">
              {data ? (data.niches.length ? <Bars horizontal items={data.niches.map((n) => ({ name: n.name, value: n.count }))} label="Leads" /> : <p className="py-10 text-center text-sm text-muted-foreground">No leads yet.</p>) : <ListSkeleton rows={4} />}
            </ChartCard>
          </div>
        </div>
      )}
    </>
  );
}

export function SalesDashboard() {
  const profile = useProfile();
  const [range, setRange] = useDashRange();
  const [addOpen, setAddOpen] = useState(false);
  const dash = useLiveQuery({
    queryKey: `dash-sales:${profile.id}:${range.from}:${range.to}`,
    fetcher: (s) => fetchDashboard<SalesData>("dashboard_sales", range, s),
    tables: ["leads", "follow_ups", "lead_activities"],
  });
  const overdue = useLiveQuery({
    queryKey: `dash-overdue:${profile.id}`,
    fetcher: (s) => fetchFollowUps({ view: "overdue", assignee: null, q: "", page: 1, pageSize: 5 }, s),
    tables: ["follow_ups", "leads"],
    pollMs: 30_000,
  });
  const today = useLiveQuery({
    queryKey: `dash-today:${profile.id}`,
    fetcher: (s) => fetchFollowUps({ view: "today", assignee: null, q: "", page: 1, pageSize: 5 }, s),
    tables: ["follow_ups", "leads"],
    pollMs: 30_000,
  });
  const refreshTasks = () => { overdue.refetch(); today.refetch(); dash.refetch(); };
  const dayLabel = useCallback((d: string) => formatDayLabel(d), []);
  const c = dash.data?.cards;

  const taskBlock = (title: string, q: typeof overdue, view: string, empty: string) => (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{title}{q.data ? <span className="ml-2 text-sm font-normal text-muted-foreground">{q.data.total}</span> : null}</CardTitle>
        <Button variant="ghost" size="sm" asChild><Link href={`/follow-ups?view=${view}`}>View all <ArrowRight /></Link></Button>
      </CardHeader>
      <CardContent>
        {q.error && !q.data ? <ErrorState message={q.error} onRetry={q.refetch} /> : q.isInitialLoading ? <ListSkeleton rows={2} /> : !q.data?.items.length ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : <FollowUpList items={q.data.items} onChanged={refreshTasks} />}
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader
        title={`Hi, ${profile.display_name.split(" ")[0]}`}
        description="Your tasks first, then your pipeline."
        actions={
          <>
            <FetchingIndicator show={dash.isFetching && !dash.isInitialLoading} />
            <RangePicker value={range} onChange={(r) => r && setRange(r)} presets={pastPresets()} ariaLabel="Dashboard date range" />
            <Button onClick={() => setAddOpen(true)}><Plus /> Add lead</Button>
          </>
        }
      />
      <div className="space-y-5">
        <div className="grid gap-5 lg:grid-cols-2">
          {taskBlock("Overdue", overdue, "overdue", "Nothing overdue. Nice.")}
          {taskBlock("Due today", today, "today", "No tasks due today.")}
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="My active leads" value={c ? formatCount(c.active_leads) : null} />
          <StatCard label="Today's tasks" value={c ? formatCount(c.today_pending) : null} />
          <StatCard label="Overdue tasks" value={c ? formatCount(c.overdue) : null} tone={c?.overdue ? "danger" : undefined} />
          <StatCard label="My won leads" value={c ? formatCount(c.won_leads) : null} tone="success" hint={`Win rate (won ÷ closed): ${winRate(c) ?? "…"}`} />
        </div>
        {dash.error && !dash.data ? <ErrorState message={dash.error} onRetry={dash.refetch} /> : (
          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCard title="My pipeline" description="My current leads by status">
              {dash.data ? <Donut items={stageItems(dash.data.stages)} totalLabel="leads" /> : <ListSkeleton rows={4} />}
            </ChartCard>
            <ChartCard title="My activity" description={`Notes, updates and follow-up actions per day · ${rangeLabel(dash.data?.range)}`}>
              {dash.data ? <TrendLine points={dash.data.activity.map((p) => ({ x: p.date, y: p.count }))} label="Activities" dateLabel={dayLabel} /> : <ListSkeleton rows={4} />}
            </ChartCard>
          </div>
        )}
      </div>
      <LeadFormDialog open={addOpen} onOpenChange={setAddOpen} initialNiches={[]} onSaved={refreshTasks} />
    </>
  );
}

export function FinanceDashboard() {
  const { data, error, isFetching, isInitialLoading, refetch } = useLiveQuery({
    queryKey: "dash-finance",
    fetcher: (s) => fetchDashboard<FinanceSummary>("dashboard_finance", 12, s),
    tables: ["expenses", "capital_entries"],
  });
  const monthLabel = useCallback((m: string) => formatMonth(m), []);
  const rangeText = data ? `${formatMonth(data.range.from)} – ${formatMonth(data.range.to)}` : "";
  return (
    <>
      <PageHeader title="Dashboard" description="Capital and operating costs (INR)." actions={<><FetchingIndicator show={isFetching && !isInitialLoading} /><Button variant="outline" asChild><Link href="/finance">Open finance <ArrowRight /></Link></Button></>} />
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <StatCard label="Total contributed capital" value={data ? formatINR(data.total_capital) : null} hint="All active capital investments" tone="success" />
            <StatCard label="Operating expenses this month" value={data ? formatINR(data.current_month_expenses) : null} hint={data ? formatMonth(data.current_month) : undefined} tone="danger" />
          </div>
          {data && data.monthly.every((m) => Number(m.total) === 0) ? (
            <EmptyState title="No expenses recorded yet" description="Monthly trends appear once expenses are added." action={<Button asChild><Link href="/finance">Add expense</Link></Button>} />
          ) : (
            <div className="grid gap-5 lg:grid-cols-2">
              <ChartCard title="Monthly operating expenses" description={rangeText}>
                {data ? <Bars items={data.monthly.map((m) => ({ name: monthLabel(m.month), value: Number(m.total) }))} label="Expenses" format={formatINRCompact} /> : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard title="Expenses by category" description={rangeText}>
                {data ? (
                  <Donut
                    totalLabel="total"
                    format={formatINRCompact}
                    items={data.categories.map((x) => ({ name: categoryLabel(x.category), value: Number(x.total), color: seriesColor(x.category) }))}
                  />
                ) : <ListSkeleton rows={4} />}
              </ChartCard>
            </div>
          )}
        </div>
      )}
    </>
  );
}
