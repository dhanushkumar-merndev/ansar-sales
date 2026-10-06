"use client";

import { useCallback, useMemo } from "react";
import { SERIES } from "@/components/charts/chart";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { Bars, ChartCard, Donut, Funnel, GroupedBars, MultiLine, ScrollTable, StatCard, WeekHourHeatmap } from "@/components/dashboard/widgets";
import { useProfile } from "@/components/providers/profile-provider";
import { MAX_RANGE_DAYS, presets, ReportRangePicker, type ReportRange } from "@/components/reports/report-range-picker";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { CATEGORY_LABELS, EXPENSE_CATEGORIES, LEAD_STATUSES, PAYMENT_MODE_LABELS, STATUS_LABELS, type ExpenseCategory, type LeadStatus, type PaymentMode } from "@/lib/constants";
import { formatCount, formatINR, formatINRCompact } from "@/lib/format";
import { can } from "@/lib/permissions";
import { fetchReport } from "@/lib/queries";
import { addDays, formatCalendarDate, formatDayLabel, formatMonth, istToday } from "@/lib/time";

type Bucket = "day" | "week" | "month";
export type RangeInfo = { from: string; to: string; bucket: Bucket };

type LeadReport = {
  range: RangeInfo; scope: "team" | "mine";
  cards: {
    created: number; won: number; lost: number; notes: number; calls: number; follow_ups_scheduled: number;
    follow_ups_completed: number; overdue_now: number; avg_days_to_win: number | null;
  };
  trend: { period: string; created: number; won: number; lost: number }[];
  activity_trend: { period: string; notes: number; calls: number; follow_ups: number }[];
  cohort_status: { status: LeadStatus; count: number }[];
  funnel: { status: LeadStatus; count: number }[];
  niches: { name: string; created: number; won: number }[];
  activity_types: { type: string; count: number }[];
  heatmap: { dow: number; hour: number; count: number }[];
  follow_up_outcomes: { on_time: number; late: number; cancelled: number; overdue: number; upcoming: number };
  salespeople: { id: string; name: string; created: number; won: number; lost: number; follow_ups_completed: number; notes: number; calls: number }[] | null;
};

export type FinanceReport = {
  range: RangeInfo & { months: number };
  cards: {
    capital_total: number; capital_entries: number; capital_before: number; expense_total: number; expense_entries: number;
    largest_expense: number | null; capital_items_quantity: number; expense_items_quantity: number; items_distinct: number;
  };
  trend: { period: string; capital: number; expense: number }[];
  categories: { category: ExpenseCategory; total: number; entries: number }[];
  category_trend: { period: string; category: ExpenseCategory; total: number }[];
  contributors: { name: string; total: number; entries: number }[];
  payment_modes: { mode: PaymentMode | "unspecified"; capital: number; expense: number }[];
  items: { kind: "capital" | "expense"; item: string; quantity: number; total: number; entries: number }[];
  top_expenses: {
    id: string; date: string; category: ExpenseCategory; amount: number; item: string | null; quantity: number | null;
    payment_mode: PaymentMode | null; description: string | null;
  }[];
};

const ACTIVITY_LABELS: Record<string, string> = {
  lead_created: "Leads created", note: "Notes", note_corrected: "Note corrections", status_changed: "Status changes",
  assigned: "Assignments", lead_updated: "Lead edits", lead_archived: "Leads archived", lead_restored: "Leads restored",
  follow_up_scheduled: "Follow-ups scheduled", follow_up_rescheduled: "Follow-ups rescheduled", follow_up_updated: "Follow-up edits",
  follow_up_completed: "Follow-ups completed", follow_up_cancelled: "Follow-ups cancelled", call_logged: "Calls logged",
  files_shared: "Files shared", share_revoked: "Shares revoked",
};

const BUCKET_TEXT: Record<Bucket, string> = { day: "per day", week: "per week (weeks start Monday)", month: "per month" };
const STATUS_COLOR = (s: LeadStatus) => SERIES[LEAD_STATUSES.indexOf(s)];
const CATEGORY_COLOR = (c: ExpenseCategory) => SERIES[EXPENSE_CATEGORIES.indexOf(c)];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);
const num = Number;

function useRange(): [ReportRange, (r: ReportRange) => void] {
  const { params, set } = useUrlState();
  const from = params.get("from");
  const to = params.get("to");
  const today = istToday();
  const valid = from && to && DATE_RE.test(from) && DATE_RE.test(to) && from <= to && to <= today && from >= addDays(to, -MAX_RANGE_DAYS);
  const fallback = presets(today).find((p) => p.key === "90d")!;
  return [valid ? { from, to } : { from: fallback.from, to: fallback.to }, (r) => set({ from: r.from, to: r.to })];
}

function usePeriodLabel(bucket?: Bucket) {
  return useCallback((p: string) => (bucket === "month" ? formatMonth(p) : formatDayLabel(p)), [bucket]);
}

const rangeText = (r: { from: string; to: string }) => `${formatCalendarDate(r.from)} – ${formatCalendarDate(r.to)} (IST)`;

export function ReportsView() {
  const { role } = useProfile();
  const { params, set } = useUrlState();
  const [range, setRange] = useRange();
  const tabs = [...(can.useLeads(role) ? (["sales"] as const) : []), ...(can.useFinance(role) ? (["finance"] as const) : [])];
  const requested = params.get("tab");
  const tab = tabs.find((t) => t === requested) ?? tabs[0];

  return (
    <>
      <PageHeader
        title="Reports"
        description={`${tab === "finance" ? "Capital and operating expenses" : role === "admin" ? "Team pipeline and activity" : "Your pipeline and activity"} for ${rangeText(range)}.`}
        actions={<ReportRangePicker value={range} onChange={setRange} />}
      />
      {tabs.length > 1 ? (
        <Tabs value={tab} onValueChange={(v) => set({ tab: v === "finance" ? "finance" : null })} className="mb-4">
          <TabsList><TabsTrigger value="sales">Sales</TabsTrigger><TabsTrigger value="finance">Finance</TabsTrigger></TabsList>
        </Tabs>
      ) : null}
      {tab === "finance" ? <FinanceReportView range={range} /> : <SalesReportView range={range} />}
    </>
  );
}

function SalesReportView({ range }: { range: ReportRange }) {
  const profile = useProfile();
  const { data, error, isFetching, isInitialLoading, refetch } = useLiveQuery({
    queryKey: `report-leads:${profile.id}:${range.from}:${range.to}`,
    fetcher: (s) => fetchReport<LeadReport>("report_leads", range.from, range.to, s),
    tables: ["leads", "follow_ups", "lead_activities"],
    pollMs: 0,
  });
  const label = usePeriodLabel(data?.range.bucket);
  const charts = useMemo(() => {
    if (!data) return null;
    const periods = data.trend.map((p) => label(p.period));
    const o = data.follow_up_outcomes;
    return {
      periods,
      activityPeriods: data.activity_trend.map((p) => label(p.period)),
      outcomes: [
        { name: "Completed on time", value: o.on_time, color: SERIES[2] },
        { name: "Completed late", value: o.late, color: SERIES[3] },
        { name: "Cancelled", value: o.cancelled, color: SERIES[5] },
        { name: "Overdue", value: o.overdue, color: SERIES[1] },
        { name: "Upcoming", value: o.upcoming, color: SERIES[0] },
      ],
      cohort: LEAD_STATUSES.map((s) => ({ name: STATUS_LABELS[s], value: data.cohort_status.find((x) => x.status === s)?.count ?? 0, color: STATUS_COLOR(s) })),
      mix: data.activity_types.filter((t) => t.type !== "lead_created").map((t) => ({ name: ACTIVITY_LABELS[t.type] ?? t.type, value: t.count })),
    };
  }, [data, label]);

  if (error && !data) return <ErrorState message={error} onRetry={refetch} />;
  const c = data?.cards;
  const per = data ? BUCKET_TEXT[data.range.bucket] : "";
  const team = data?.scope === "team";

  return (
    <div className="space-y-5">
      <div className="flex justify-end"><FetchingIndicator show={isFetching && !isInitialLoading} /></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Leads created" value={c ? formatCount(c.created) : null} hint="New leads in this range" />
        <StatCard label="Won" value={c ? formatCount(c.won) : null} tone="success" hint={c ? `Win rate (won ÷ closed): ${pct(c.won, c.won + c.lost)}` : undefined} />
        <StatCard label="Lost" value={c ? formatCount(c.lost) : null} hint="Marked lost in this range" />
        <StatCard label="Avg days to win" value={c ? (c.avg_days_to_win === null ? "—" : String(c.avg_days_to_win)) : null} hint="From lead creation to won" />
        <StatCard label="Follow-ups completed" value={c ? formatCount(c.follow_ups_completed) : null} hint={c ? `${formatCount(c.follow_ups_scheduled)} scheduled in this range` : undefined} />
        <StatCard label="Overdue now" value={c ? formatCount(c.overdue_now) : null} tone={c?.overdue_now ? "danger" : undefined} hint="Pending and past due, any date" />
        <StatCard label="Notes added" value={c ? formatCount(c.notes) : null} />
        <StatCard label="Calls logged" value={c ? formatCount(c.calls) : null} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard className="lg:col-span-2" title="Leads created, won and lost" description={`${team ? "Team" : "My leads"}, ${per}. Won and lost count the day a lead was closed.`}>
          {data && charts ? (
            <MultiLine
              categories={charts.periods}
              series={[
                { name: "Created", values: data.trend.map((p) => p.created), color: SERIES[0] },
                { name: "Won", values: data.trend.map((p) => p.won), color: STATUS_COLOR("won") },
                { name: "Lost", values: data.trend.map((p) => p.lost), color: STATUS_COLOR("lost") },
              ]}
            />
          ) : <ListSkeleton rows={4} />}
        </ChartCard>
        <ChartCard title="Stage funnel" description="Leads created in this range by the furthest stage they reached">
          {data ? <Funnel steps={data.funnel.map((f) => ({ name: STATUS_LABELS[f.status], value: f.count }))} /> : <ListSkeleton rows={4} />}
        </ChartCard>
        <ChartCard title="Where those leads are now" description="Current status of leads created in this range">
          {charts ? <Donut items={charts.cohort} totalLabel="leads" /> : <ListSkeleton rows={4} />}
        </ChartCard>
        <ChartCard title="Activity" description={`Notes, calls and completed follow-ups, ${per}`}>
          {data && charts ? (
            <GroupedBars
              stacked
              categories={charts.activityPeriods}
              series={[
                { name: "Notes", values: data.activity_trend.map((p) => p.notes) },
                { name: "Calls", values: data.activity_trend.map((p) => p.calls) },
                { name: "Follow-ups completed", values: data.activity_trend.map((p) => p.follow_ups) },
              ]}
            />
          ) : <ListSkeleton rows={4} />}
        </ChartCard>
        <ChartCard title="Follow-up outcomes" description="Follow-ups due in this range, by what happened">
          {charts ? <Donut items={charts.outcomes} totalLabel="follow-ups" /> : <ListSkeleton rows={4} />}
        </ChartCard>
        <ChartCard title="Niches" description="Leads created in this range per niche, and how many are won (top 10)">
          {data ? (data.niches.length ? (
            <GroupedBars
              categories={data.niches.map((n) => n.name)}
              series={[
                { name: "Created", values: data.niches.map((n) => n.created), color: SERIES[0] },
                { name: "Won", values: data.niches.map((n) => n.won), color: STATUS_COLOR("won") },
              ]}
            />
          ) : <NoData />) : <ListSkeleton rows={4} />}
        </ChartCard>
        <ChartCard title="Activity mix" description="Everything recorded on leads in this range, by type">
          {charts ? (charts.mix.length ? <Bars horizontal items={charts.mix} label="Activities" /> : <NoData />) : <ListSkeleton rows={4} />}
        </ChartCard>
        <ChartCard className="lg:col-span-2" title="When work happens" description="Activities by weekday and hour (IST), excluding lead creation">
          {data ? (data.heatmap.length ? <WeekHourHeatmap cells={data.heatmap} label="activities" /> : <NoData />) : <ListSkeleton rows={4} />}
        </ChartCard>
        {team && data?.salespeople ? (
          <ChartCard className="lg:col-span-2" title="By salesperson" description="Leads created and closed in this range for leads each person owns now, plus their own follow-ups, notes and calls">
            {data.salespeople.length ? (
              <div className="space-y-4">
                <GroupedBars
                  categories={data.salespeople.map((s) => s.name)}
                  series={[
                    { name: "Created", values: data.salespeople.map((s) => s.created), color: SERIES[0] },
                    { name: "Won", values: data.salespeople.map((s) => s.won), color: STATUS_COLOR("won") },
                    { name: "Lost", values: data.salespeople.map((s) => s.lost), color: STATUS_COLOR("lost") },
                    { name: "Follow-ups completed", values: data.salespeople.map((s) => s.follow_ups_completed), color: SERIES[2] },
                  ]}
                />
                <ScrollTable><Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Salesperson</TableHead><TableHead className="text-right">Created</TableHead><TableHead className="text-right">Won</TableHead>
                      <TableHead className="text-right">Lost</TableHead><TableHead className="text-right">Win rate</TableHead>
                      <TableHead className="text-right">Follow-ups done</TableHead><TableHead className="text-right">Notes</TableHead><TableHead className="text-right">Calls</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="tabular-nums">
                    {data.salespeople.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{s.name}</TableCell><TableCell className="text-right">{formatCount(s.created)}</TableCell>
                        <TableCell className="text-right">{formatCount(s.won)}</TableCell><TableCell className="text-right">{formatCount(s.lost)}</TableCell>
                        <TableCell className="text-right">{pct(s.won, s.won + s.lost)}</TableCell><TableCell className="text-right">{formatCount(s.follow_ups_completed)}</TableCell>
                        <TableCell className="text-right">{formatCount(s.notes)}</TableCell><TableCell className="text-right">{formatCount(s.calls)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table></ScrollTable>
              </div>
            ) : <NoData />}
          </ChartCard>
        ) : null}
      </div>
    </div>
  );
}

function FinanceReportView({ range }: { range: ReportRange }) {
  const { data, error, isFetching, isInitialLoading, refetch } = useLiveQuery({
    queryKey: `report-finance:${range.from}:${range.to}`,
    fetcher: (s) => fetchReport<FinanceReport>("report_finance", range.from, range.to, s),
    tables: ["expenses", "capital_entries"],
    pollMs: 0,
  });
  const label = usePeriodLabel(data?.range.bucket);
  const charts = useMemo(() => {
    if (!data) return null;
    const periods = data.trend.map((p) => label(p.period));
    let running = num(data.cards.capital_before);
    const cumulative = data.trend.map((p) => (running += num(p.capital)));
    const catPeriods = data.trend.map((p) => p.period);
    return {
      periods,
      cumulative,
      categories: EXPENSE_CATEGORIES.map((cat) => ({ name: CATEGORY_LABELS[cat], value: num(data.categories.find((x) => x.category === cat)?.total ?? 0), color: CATEGORY_COLOR(cat) })),
      categoryTrend: EXPENSE_CATEGORIES.filter((cat) => data.categories.some((x) => x.category === cat)).map((cat) => ({
        name: CATEGORY_LABELS[cat], color: CATEGORY_COLOR(cat),
        values: catPeriods.map((p) => num(data.category_trend.find((x) => x.period === p && x.category === cat)?.total ?? 0)),
      })),
    };
  }, [data, label]);

  if (error && !data) return <ErrorState message={error} onRetry={refetch} />;
  const c = data?.cards;
  const per = data ? BUCKET_TEXT[data.range.bucket] : "";
  const empty = c && c.capital_entries === 0 && c.expense_entries === 0;

  return (
    <div className="space-y-5">
      <div className="flex justify-end"><FetchingIndicator show={isFetching && !isInitialLoading} /></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Capital contributed" value={c ? formatINR(c.capital_total) : null} tone="success" hint={c ? `${formatCount(c.capital_entries)} entries in this range` : undefined} />
        <StatCard label="Operating expenses" value={c ? formatINR(c.expense_total) : null} tone="danger" hint={c ? `${formatCount(c.expense_entries)} entries in this range` : undefined} />
        <StatCard label="Average expense per month" value={data ? formatINR(num(data.cards.expense_total) / Math.max(1, data.range.months)) : null} hint={data ? `Over ${data.range.months} calendar month${data.range.months === 1 ? "" : "s"}` : undefined} />
        <StatCard label="Items (nos)" value={c ? `${formatCount(num(c.capital_items_quantity) + num(c.expense_items_quantity))} nos` : null} hint={c ? `${formatCount(c.expense_items_quantity)} bought as expenses, ${formatCount(c.capital_items_quantity)} on capital` : undefined} />
      </div>
      {empty ? (
        <EmptyState title="Nothing recorded in this range" description="Pick a wider range, or add capital and expenses on the Finance page." />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <ChartCard className="lg:col-span-2" title="Capital and expenses" description={`Shown side by side ${per}. They are not netted: capital is not revenue.`}>
            {data && charts ? (
              <GroupedBars
                format={formatINRCompact}
                categories={charts.periods}
                series={[
                  { name: "Capital", values: data.trend.map((p) => num(p.capital)), color: SERIES[2] },
                  { name: "Expenses", values: data.trend.map((p) => num(p.expense)), color: SERIES[1] },
                ]}
              />
            ) : <ListSkeleton rows={4} />}
          </ChartCard>
          <ChartCard title="Total capital contributed" description={`Running total including ${data ? formatINRCompact(data.cards.capital_before) : "…"} contributed before this range`}>
            {charts ? <MultiLine area format={formatINRCompact} categories={charts.periods} series={[{ name: "Total contributed", values: charts.cumulative, color: SERIES[2] }]} /> : <ListSkeleton rows={4} />}
          </ChartCard>
          <ChartCard title="Expenses by category" description="Share of operating expenses in this range">
            {charts ? <Donut items={charts.categories} format={formatINRCompact} totalLabel="total" /> : <ListSkeleton rows={4} />}
          </ChartCard>
          <ChartCard className="lg:col-span-2" title="Category trend" description={`Operating expenses ${per}, stacked by category`}>
            {charts ? (charts.categoryTrend.length ? <GroupedBars stacked format={formatINRCompact} categories={charts.periods} series={charts.categoryTrend} /> : <NoData />) : <ListSkeleton rows={4} />}
          </ChartCard>
          <ChartCard title="Mode of payment" description="Capital and expenses in this range by how they were paid">
            {data ? (data.payment_modes.length ? (
              <GroupedBars
                format={formatINRCompact}
                categories={data.payment_modes.map((m) => (m.mode === "unspecified" ? "Not recorded" : PAYMENT_MODE_LABELS[m.mode]))}
                series={[
                  { name: "Capital", values: data.payment_modes.map((m) => num(m.capital)), color: SERIES[2] },
                  { name: "Expenses", values: data.payment_modes.map((m) => num(m.expense)), color: SERIES[1] },
                ]}
              />
            ) : <NoData />) : <ListSkeleton rows={4} />}
          </ChartCard>
          <ChartCard title="Items by amount" description="Named items on expenses and capital in this range (top 30)">
            {data ? (data.items.length ? (
              <GroupedBars
                format={formatINRCompact}
                categories={itemNames(data.items)}
                series={[
                  { name: "Expenses", values: itemNames(data.items).map((n) => itemTotal(data.items, "expense", n)), color: SERIES[1] },
                  { name: "Capital", values: itemNames(data.items).map((n) => itemTotal(data.items, "capital", n)), color: SERIES[2] },
                ]}
                stacked
              />
            ) : <NoData text="No items recorded. Add an item and nos when recording an expense or capital." />) : <ListSkeleton rows={4} />}
          </ChartCard>
          <ChartCard title="Capital by contributor" description="Who contributed in this range (top 10)">
            {data ? (data.contributors.length ? <Bars horizontal items={data.contributors.map((x) => ({ name: x.name, value: num(x.total) }))} label="Capital" format={formatINRCompact} /> : <NoData />) : <ListSkeleton rows={4} />}
          </ChartCard>
          <ChartCard className="lg:col-span-2" title="Items" description="Quantity (nos), amount and average amount per unit">
            {data ? (data.items.length ? (
              <ScrollTable><Table>
                <TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Recorded as</TableHead><TableHead className="text-right">Nos</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Per unit</TableHead></TableRow></TableHeader>
                <TableBody className="tabular-nums">
                  {data.items.map((i) => (
                    <TableRow key={`${i.kind}:${i.item}`}>
                      <TableCell className="font-medium">{i.item}<span className="block text-xs font-normal text-muted-foreground">{formatCount(i.entries)} {i.entries === 1 ? "entry" : "entries"}</span></TableCell>
                      <TableCell>{i.kind === "expense" ? "Expense" : "Capital"}</TableCell>
                      <TableCell className="text-right">{i.quantity ? formatCount(i.quantity) : "—"}</TableCell>
                      <TableCell className="text-right">{formatINR(i.total)}</TableCell>
                      <TableCell className="text-right">{i.quantity ? formatINR(num(i.total) / num(i.quantity)) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table></ScrollTable>
            ) : <NoData text="No items recorded in this range." />) : <ListSkeleton rows={4} />}
          </ChartCard>
          <ChartCard title="Largest expenses" description="Top 10 operating expenses in this range">
            {data ? (data.top_expenses.length ? (
              <ScrollTable><Table>
                <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Category</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
                <TableBody className="tabular-nums">
                  {data.top_expenses.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{formatCalendarDate(e.date)}</TableCell>
                      <TableCell>
                        {CATEGORY_LABELS[e.category]}
                        {e.item || e.description ? <span className="block max-w-[14rem] truncate text-xs text-muted-foreground">{e.item ? `${e.item}${e.quantity ? ` × ${formatCount(e.quantity)} nos` : ""}` : e.description}</span> : null}
                      </TableCell>
                      <TableCell className="text-right">{formatINR(e.amount)}{e.payment_mode ? <span className="block text-xs text-muted-foreground">{PAYMENT_MODE_LABELS[e.payment_mode]}</span> : null}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table></ScrollTable>
            ) : <NoData />) : <ListSkeleton rows={4} />}
          </ChartCard>
        </div>
      )}
    </div>
  );
}

const itemNames = (items: FinanceReport["items"]) => [...new Set(items.map((i) => i.item))];
const itemTotal = (items: FinanceReport["items"], kind: "capital" | "expense", name: string) =>
  num(items.find((i) => i.kind === kind && i.item === name)?.total ?? 0);

function NoData({ text = "No data in this range." }: { text?: string }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{text}</p>;
}
