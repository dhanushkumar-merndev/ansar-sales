"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { SERIES, seriesColor } from "@/components/charts/chart";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { Bars, ChartCard, Donut, GroupedBars, MultiLine, ScrollTable, StatCard } from "@/components/dashboard/widgets";
import { CapitalDialog, ExpenseDialog, FinanceHistoryDialog, type FinanceEntity } from "@/components/finance/finance-dialogs";
import { FinanceEntries } from "@/components/finance/finance-entries";
import { change } from "@/components/finance/finance-view";
import type { FinanceReport } from "@/components/reports/reports-view";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLiveQuery } from "@/hooks/use-live-query";
import { categoryLabel, PAYMENT_MODE_LABELS, type ExpenseCategory } from "@/lib/constants";
import { formatCount, formatINR, formatINRCompact } from "@/lib/format";
import { fetchPeriodReport, type CapitalRow, type ExpenseRow } from "@/lib/queries";
import { formatCalendarDate, formatDayLabel, formatMonth, formatMonthLong, istToday, parsePeriod } from "@/lib/time";

type PeriodReport = FinanceReport & {
  period: { from: string; to: string; is_month: boolean; series_bucket: "day" | "month" };
  series: { period: string; expense: number; capital: number; expense_cumulative: number; capital_cumulative: number }[];
  previous: { from: string; to: string; expense: number; capital: number };
  last_year: { expense: number; capital: number };
  avg_prior_6: number | null;
  prev_categories: { category: ExpenseCategory; total: number }[];
  recurring_split: { monthly: number; monthly_entries: number; one_off: number; one_off_entries: number };
  weekday: { dow: number; total: number; entries: number }[];
  size_buckets: { bucket: string; entries: number; total: number }[];
  recorded_by: { name: string; entries: number; total: number }[];
  archived: { expense: number; capital: number };
};

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const num = Number;

export function FinancePeriodView({ periodKey }: { periodKey: string }) {
  const period = parsePeriod(periodKey)!;
  const router = useRouter();
  const [today] = useState(istToday); // fixed for the page's lifetime (keeps chart memos stable)
  const current = period.kind === "month" ? today.slice(0, 7) : today.slice(0, 4);
  const isMonth = period.kind === "month";

  const { data, error, isFetching, isInitialLoading, refetch } = useLiveQuery({
    queryKey: `finance-period:${period.key}`,
    fetcher: (s) => fetchPeriodReport<PeriodReport>(period.from, period.to, s),
    tables: ["expenses", "capital_entries"],
    pollMs: 0,
  });

  const [editing, setEditing] = useState<{ kind: "expense"; row: ExpenseRow | null } | { kind: "capital"; row: CapitalRow | null } | null>(null);
  const [history, setHistory] = useState<FinanceEntity | null>(null);
  const defaultDate = today >= period.from && today <= period.to ? today : period.from;

  const seriesLabel = useCallback((p: string) => (isMonth ? formatDayLabel(p) : formatMonth(p)), [isMonth]);
  const charts = useMemo(() => (data ? buildCharts(data, seriesLabel, today) : null), [data, seriesLabel, today]);

  const c = data?.cards;
  const prevName = isMonth ? formatMonthLong(period.prev) : period.prev;
  const expense = num(c?.expense_total ?? 0);
  // Average over the days (or months) elapsed so far when the period is still running.
  const elapsed = isMonth
    ? (today >= period.to ? num(period.to.slice(8)) : today >= period.from ? num(today.slice(8)) : 0)
    : (today >= period.to ? 12 : today >= period.from ? num(today.slice(5, 7)) : 0);
  const hint = (cur: number, prev: number, last: number) => `${change(cur, prev).text} vs ${prevName} · ${change(cur, last).text} vs last year`;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/finance" className="hover:text-foreground">Finance</Link>
        <ChevronRight className="size-3.5" />
        {isMonth ? <><Link href={`/finance?year=${period.year}`} className="hover:text-foreground">{period.year}</Link><ChevronRight className="size-3.5" /></> : null}
        <span className="text-foreground">{isMonth ? formatMonth(period.key) : period.label}</span>
      </nav>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{period.label}</h1>
            <div className="inline-flex items-center rounded-lg border border-white/[0.12] bg-card/60 p-0.5 shadow-2xs">
              <Button
                variant="ghost"
                size="icon-xs"
                asChild
                aria-label={`Previous: ${prevName}`}
                className="size-7 rounded-md text-muted-foreground hover:text-foreground"
              >
                <Link href={`/finance/${period.prev}`}>
                  <ChevronLeft className="size-4" />
                </Link>
              </Button>
              <div className="h-3.5 w-px bg-white/[0.12]" />
              {period.next <= current ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  asChild
                  aria-label={`Next: ${isMonth ? formatMonthLong(period.next) : period.next}`}
                  className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                >
                  <Link href={`/finance/${period.next}`}>
                    <ChevronRight className="size-4" />
                  </Link>
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled
                  aria-label="Next period (not started)"
                  className="size-7 rounded-md opacity-35"
                >
                  <ChevronRight className="size-4" />
                </Button>
              )}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">{formatCalendarDate(period.from)} – {formatCalendarDate(period.to)} · capital and expenses are shown side by side, never netted.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FetchingIndicator show={isFetching && !isInitialLoading} />
          {isMonth ? <Button variant="ghost" size="sm" asChild><Link href={`/finance/${period.year}`}>{period.year} report</Link></Button> : null}
          <Button variant="outline" onClick={() => setEditing({ kind: "capital", row: null })}><Plus /> Add capital</Button>
          <Button onClick={() => setEditing({ kind: "expense", row: null })}><Plus /> Add expense</Button>
        </div>
      </div>

      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Expenses" value={c ? formatINR(c.expense_total) : null} tone="danger"
              hint={data ? hint(expense, num(data.previous.expense), num(data.last_year.expense)) : undefined} />
            <StatCard label="Capital" value={c ? formatINR(c.capital_total) : null} tone="success"
              hint={data ? hint(num(c!.capital_total), num(data.previous.capital), num(data.last_year.capital)) : undefined} />
            <StatCard label="Entries" value={c ? formatCount(c.expense_entries + c.capital_entries) : null}
              hint={c ? `${formatCount(c.expense_entries)} expenses · ${formatCount(c.capital_entries)} capital${data?.archived.expense || data?.archived.capital ? ` · ${formatCount(num(data.archived.expense) + num(data.archived.capital))} archived` : ""}` : undefined} />
            <StatCard label={isMonth ? "Average expense per day" : "Average expense per month"} value={c ? (elapsed ? formatINR(expense / elapsed) : "—") : null}
              hint={elapsed ? `Over ${elapsed} ${isMonth ? "day" : "month"}${elapsed === 1 ? "" : "s"} so far` : "Period not started"} />
            <StatCard label="Largest expense" value={c ? (c.largest_expense === null ? "—" : formatINR(c.largest_expense)) : null}
              hint={data?.top_expenses[0] ? `${categoryLabel(data.top_expenses[0].category)}${data.top_expenses[0].item ? ` · ${data.top_expenses[0].item}` : ""}` : undefined} />
            <StatCard label="Items (nos)" value={c ? `${formatCount(num(c.expense_items_quantity) + num(c.capital_items_quantity))} nos` : null}
              hint={c ? `${formatCount(c.expense_items_quantity)} bought · ${formatCount(c.capital_items_quantity)} on capital` : undefined} />
            <StatCard label="From monthly series" value={data ? (expense ? `${Math.round((num(data.recurring_split.monthly) / expense) * 100)}%` : "—") : null}
              hint={data ? `${formatINR(data.recurring_split.monthly)} in ${formatCount(data.recurring_split.monthly_entries)} repeating entries` : undefined} />
            {isMonth ? (
              <StatCard label="Versus 6-month average" value={data ? (data.avg_prior_6 ? change(expense, num(data.avg_prior_6)).text : "—") : null}
                hint={data?.avg_prior_6 ? `Average ${formatINR(data.avg_prior_6)} a month before this` : "No earlier months"} />
            ) : (
              <StatCard label="Capital entries" value={c ? formatCount(c.capital_entries) : null} hint={c ? `${formatCount(c.items_distinct)} different items recorded` : undefined} />
            )}
          </div>

          {data && c && c.expense_entries === 0 && c.capital_entries === 0 ? (
            <EmptyState title={`Nothing recorded in ${period.label}`} description="Add an expense or capital entry, or pick another period." />
          ) : (
            <div className="grid gap-5 lg:grid-cols-2">
              <ChartCard className="lg:col-span-2" title={isMonth ? "Day by day" : "Month by month"}
                description={isMonth ? "Expenses and capital per day" : "Expenses and capital per month. Click a month to open its report."}>
                {charts ? (
                  <GroupedBars format={formatINRCompact} categories={charts.series.labels}
                    series={[{ name: "Expenses", values: charts.series.expense, color: SERIES[1] }, { name: "Capital", values: charts.series.capital, color: SERIES[2] }]}
                    onItemClick={isMonth ? undefined : ({ dataIndex }) => charts.series.periods[dataIndex] && router.push(`/finance/${charts.series.periods[dataIndex].slice(0, 7)}`)} />
                ) : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard title="Running total" description={`Expenses and capital added up through ${isMonth ? "the month" : "the year"}`}>
                {charts ? <MultiLine area format={formatINRCompact} categories={charts.series.labels}
                  series={[{ name: "Expenses", values: charts.series.expenseCum, color: SERIES[1] }, { name: "Capital", values: charts.series.capitalCum, color: SERIES[2] }]} /> : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard title="Expenses by category" description="Share of this period's operating expenses">
                {charts ? <Donut items={charts.categories} format={formatINRCompact} totalLabel="total" /> : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard title="Category versus previous" description={`This period against ${prevName}`}>
                {charts ? (charts.categoryCompare.length ? (
                  <GroupedBars format={formatINRCompact} categories={charts.categoryCompare.map((x) => x.name)}
                    series={[{ name: period.label, values: charts.categoryCompare.map((x) => x.now), color: SERIES[0] }, { name: prevName, values: charts.categoryCompare.map((x) => x.prev), color: SERIES[3] }]} />
                ) : <NoData />) : <ListSkeleton rows={4} />}
              </ChartCard>
              {!isMonth ? (
                <ChartCard title="Category per month" description="Operating expenses per month, stacked by category">
                  {charts ? (charts.categoryTrend.length ? <GroupedBars stacked format={formatINRCompact} categories={charts.series.labels} series={charts.categoryTrend} /> : <NoData />) : <ListSkeleton rows={4} />}
                </ChartCard>
              ) : null}
              <ChartCard title="Mode of payment" description="How capital and expenses were paid">
                {data ? (data.payment_modes.length ? (
                  <GroupedBars format={formatINRCompact}
                    categories={data.payment_modes.map((m) => (m.mode === "unspecified" ? "Not recorded" : PAYMENT_MODE_LABELS[m.mode]))}
                    series={[{ name: "Capital", values: data.payment_modes.map((m) => num(m.capital)), color: SERIES[2] }, { name: "Expenses", values: data.payment_modes.map((m) => num(m.expense)), color: SERIES[1] }]} />
                ) : <NoData />) : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard title="Monthly series versus one-off" description="Expenses added by a repeating monthly series, and everything else">
                {data ? <Donut format={formatINRCompact} totalLabel="expenses" items={[
                  { name: `Monthly series (${formatCount(data.recurring_split.monthly_entries)})`, value: num(data.recurring_split.monthly), color: SERIES[0] },
                  { name: `One-off (${formatCount(data.recurring_split.one_off_entries)})`, value: num(data.recurring_split.one_off), color: SERIES[3] },
                ]} /> : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard title="Spending by weekday" description="Expense amount by the day of the week it was dated">
                {data ? <Bars items={data.weekday.map((w) => ({ name: WEEKDAYS[w.dow - 1].slice(0, 3), value: num(w.total) }))} label="Expenses" format={formatINRCompact} /> : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard title="Expense sizes" description="How many expenses fall in each amount band">
                {data ? <Bars items={data.size_buckets.map((b) => ({ name: b.bucket, value: b.entries }))} label="Expenses" /> : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard title="Items by nos" description="Quantity of each named item (top 30 by amount)">
                {data ? (data.items.length ? <Bars horizontal items={data.items.filter((i) => num(i.quantity) > 0).map((i) => ({ name: `${i.item} (${i.kind === "expense" ? "expense" : "capital"})`, value: num(i.quantity) }))} label="Nos" format={(n) => `${formatCount(n)} nos`} />
                  : <NoData text="No items recorded. Add an item and nos when recording an entry." />) : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard title="Capital by contributor" description="Who contributed in this period (top 10)">
                {data ? (data.contributors.length ? <Bars horizontal items={data.contributors.map((x) => ({ name: x.name, value: num(x.total) }))} label="Capital" format={formatINRCompact} /> : <NoData />) : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard title="Recorded by" description="Who entered this period's entries">
                {data ? (data.recorded_by.length ? <Bars horizontal items={data.recorded_by.map((x) => ({ name: x.name, value: x.entries }))} label="Entries" /> : <NoData />) : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard title="Items" description="Quantity, amount and amount per unit">
                {data ? (data.items.length ? (
                  <ScrollTable><Table>
                    <TableHeader><TableRow><TableHead>Item</TableHead><TableHead className="text-right">Nos</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Per unit</TableHead></TableRow></TableHeader>
                    <TableBody className="tabular-nums">
                      {data.items.map((i) => (
                        <TableRow key={`${i.kind}:${i.item}`}>
                          <TableCell className="font-medium">{i.item}<span className="block text-xs font-normal text-muted-foreground">{i.kind === "expense" ? "Expense" : "Capital"} · {formatCount(i.entries)} {i.entries === 1 ? "entry" : "entries"}</span></TableCell>
                          <TableCell className="text-right">{num(i.quantity) ? formatCount(i.quantity) : "—"}</TableCell>
                          <TableCell className="text-right">{formatINR(i.total)}</TableCell>
                          <TableCell className="text-right">{num(i.quantity) ? formatINR(num(i.total) / num(i.quantity)) : "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table></ScrollTable>
                ) : <NoData text="No items recorded in this period." />) : <ListSkeleton rows={4} />}
              </ChartCard>
              <ChartCard className={isMonth ? undefined : "lg:col-span-2"} title="Largest expenses" description="Top 10 in this period">
                {data ? (data.top_expenses.length ? (
                  <ScrollTable><Table>
                    <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Category</TableHead><TableHead className="text-right">Amount</TableHead></TableRow></TableHeader>
                    <TableBody className="tabular-nums">
                      {data.top_expenses.map((e) => (
                        <TableRow key={e.id}>
                          <TableCell className="whitespace-nowrap">{formatCalendarDate(e.date)}</TableCell>
                          <TableCell>{categoryLabel(e.category)}{e.item || e.description ? <span className="block max-w-[14rem] truncate text-xs text-muted-foreground">{e.item ? `${e.item}${e.quantity ? ` × ${formatCount(e.quantity)} nos` : ""}` : e.description}</span> : null}</TableCell>
                          <TableCell className="text-right">{formatINR(e.amount)}{e.payment_mode ? <span className="block text-xs text-muted-foreground">{PAYMENT_MODE_LABELS[e.payment_mode]}</span> : null}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table></ScrollTable>
                ) : <NoData />) : <ListSkeleton rows={4} />}
              </ChartCard>
            </div>
          )}

          <FinanceEntries
            from={period.from}
            to={period.to}
            fileLabel={period.key}
            onEditExpense={(row) => setEditing({ kind: "expense", row })}
            onEditCapital={(row) => setEditing({ kind: "capital", row })}
            onHistory={(kind, id) => setHistory({ kind, id })}
            onChanged={refetch}
          />
        </div>
      )}

      <ExpenseDialog open={editing?.kind === "expense"} onOpenChange={(o) => !o && setEditing(null)} expense={editing?.kind === "expense" ? editing.row : null} defaultDate={defaultDate} onDone={refetch} />
      <CapitalDialog open={editing?.kind === "capital"} onOpenChange={(o) => !o && setEditing(null)} entry={editing?.kind === "capital" ? editing.row : null} defaultDate={defaultDate} onDone={refetch} />
      <FinanceHistoryDialog entity={history} onClose={() => setHistory(null)} />
    </>
  );
}

function buildCharts(data: PeriodReport, label: (p: string) => string, today: string) {
  const prev = new Map(data.prev_categories.map((x) => [x.category, num(x.total)]));
  const now = new Map(data.categories.map((x) => [x.category, num(x.total)]));
  // A running period stops at today, so lines don't run flat through days or months that haven't happened.
  const series = data.series.filter((p) => p.period <= today);
  const periods = series.map((p) => p.period);
  return {
    series: {
      periods,
      labels: series.map((p) => label(p.period)),
      expense: series.map((p) => num(p.expense)),
      capital: series.map((p) => num(p.capital)),
      expenseCum: series.map((p) => num(p.expense_cumulative)),
      capitalCum: series.map((p) => num(p.capital_cumulative)),
    },
    categories: [...now.entries()].sort((a, b) => b[1] - a[1]).map(([cat, v]) => ({ name: categoryLabel(cat), value: v, color: seriesColor(cat) })),
    categoryCompare: [...new Set([...now.keys(), ...prev.keys()])]
      .map((cat) => ({ name: categoryLabel(cat), now: now.get(cat) ?? 0, prev: prev.get(cat) ?? 0 })),
    // report_finance buckets a full year by month, matching the series periods.
    categoryTrend: [...now.keys()].map((cat) => ({
      name: categoryLabel(cat), color: seriesColor(cat),
      values: periods.map((p) => num(data.category_trend.find((x) => x.period === p && x.category === cat)?.total ?? 0)),
    })),
  };
}

function NoData({ text = "No data in this period." }: { text?: string }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{text}</p>;
}
