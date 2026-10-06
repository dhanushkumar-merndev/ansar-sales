"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Info, Plus, TrendingDown, TrendingUp } from "lucide-react";
import { SERIES, seriesColor } from "@/components/charts/chart";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { ChartCard, GroupedBars } from "@/components/dashboard/widgets";
import { CapitalDialog, ExpenseDialog } from "@/components/finance/finance-dialogs";
import { MonthDetailsDialog } from "@/components/finance/month-details-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { useFinanceBooks } from "@/components/finance/finance-books";
import { type ExpenseCategory } from "@/lib/constants";
import { formatCount, formatINR, formatINRCompact } from "@/lib/format";
import { fetchDashboard, fetchYearOverview, nextMonth, type YearOverview } from "@/lib/queries";
import { createClient } from "@/lib/supabase/client";
import { formatMonth, formatMonthLong, istToday } from "@/lib/time";
import { cn } from "@/lib/utils";

export type FinanceSummary = {
  range: { from: string; to: string; months: number };
  total_capital: number; current_month: string; current_month_expenses: number;
  monthly: { month: string; total: number }[]; categories: { category: ExpenseCategory; total: number }[];
};

export function FinanceView() {
  const summary = useLiveQuery({
    queryKey: "finance-summary",
    fetcher: (s) => fetchDashboard<FinanceSummary>("dashboard_finance", 12, s),
    tables: ["expenses", "capital_entries"],
  });

  const currentMonthStr = summary.data?.current_month ? String(summary.data.current_month).slice(0, 7) : null;
  const monthCapitalQuery = useLiveQuery({
    queryKey: `finance-current-month-capital:${currentMonthStr}`,
    fetcher: async (s) => {
      if (!currentMonthStr) return 0;
      const { data, error } = await createClient()
        .from("capital_entries")
        .select("amount")
        .is("archived_at", null)
        .gte("entry_date", `${currentMonthStr}-01`)
        .lt("entry_date", nextMonth(currentMonthStr))
        .abortSignal(s);
      if (error) throw error;
      return (data ?? []).reduce((acc: number, row: { amount: number }) => acc + Number(row.amount), 0);
    },
    tables: ["capital_entries"],
  });

  const [adding, setAdding] = useState<"expense" | "capital" | null>(null);

  const monthCapital = monthCapitalQuery.data ?? 0;
  const monthExpenses = summary.data?.current_month_expenses ?? 0;
  const netThisMonth = monthCapital - monthExpenses;
  const totalCapital = summary.data?.total_capital ?? 0;
  const currentMonthLabel = summary.data ? formatMonth(summary.data.current_month) : "This month";

  const refresh = () => { summary.refetch(); monthCapitalQuery.refetch(); };
  const books = useFinanceBooks().data;

  return (
    <>
      <PageHeader
        title="Finance"
        description={books?.merged
          ? `Shared books of ${books.companies.map((c) => c.name).join(", ")} (INR).${books.canEdit ? "" : " View only for your company."}`
          : "Capital invested and monthly operating expenses (INR). Profit and cash balance are not calculated."}
        actions={books?.canEdit ? <>
          <Button variant="outline" onClick={() => setAdding("capital")}><Plus /> Add capital</Button>
          <Button onClick={() => setAdding("expense")}><Plus /> Add expense</Button>
        </> : undefined}
      />
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FinanceStatCard
          title="This Month Capital Gained"
          value={monthCapitalQuery.data !== undefined ? `+${formatINR(monthCapital)}` : null}
          hint={`All-time contributed: ${formatINR(totalCapital)}`}
          tone="success"
          icon={<TrendingUp className="size-3.5" />}
          badge="High / Inflow"
        />
        <FinanceStatCard
          title="Expense This Month"
          value={summary.data ? `−${formatINR(monthExpenses)}` : null}
          hint={`${currentMonthLabel} operating costs`}
          tone="danger"
          icon={<TrendingDown className="size-3.5" />}
          badge="Low / Outflow"
        />
        <FinanceStatCard
          title="Net Cash Flow (This Month)"
          value={
            summary.data && monthCapitalQuery.data !== undefined
              ? (netThisMonth >= 0 ? `+${formatINR(netThisMonth)}` : `−${formatINR(Math.abs(netThisMonth))}`)
              : null
          }
          hint={
            netThisMonth >= 0
              ? "Capital surplus after monthly expenses"
              : "Deficit (expenses exceed capital gained)"
          }
          tone={netThisMonth >= 0 ? "success" : "danger"}
          icon={netThisMonth >= 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
          badge={netThisMonth >= 0 ? "Surplus" : "Deficit"}
        />
      </div>
      <MonthOverview />
      <ExpenseDialog open={adding === "expense"} onOpenChange={(o) => setAdding(o ? "expense" : null)} onDone={refresh} />
      <CapitalDialog open={adding === "capital"} onOpenChange={(o) => setAdding(o ? "capital" : null)} onDone={refresh} />
    </>
  );
}


/** "▲ 12%" / "▼ 8%" against a previous total; text, so the change never relies on colour alone. */
export function change(current: number, previous: number) {
  if (previous === 0) return current === 0 ? { text: "No change", up: null } : { text: "New", up: true };
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct === 0 ? { text: "No change", up: null } : { text: `${pct > 0 ? "▲" : "▼"} ${Math.abs(pct)}%`, up: pct > 0 };
}

/** Year picker, a clickable month chart and one card per month; each opens that period's report. */
function MonthOverview() {
  const router = useRouter();
  const { params, set } = useUrlState();
  const currentYear = Number(istToday().slice(0, 4));
  const rawYear = Number(params.get("year"));
  const year = Number.isInteger(rawYear) && rawYear >= 1900 && rawYear <= 2999 ? rawYear : currentYear;
  const { data, error, isFetching, isInitialLoading, isStale, refetch } = useLiveQuery({
    queryKey: `finance-year:${year}`,
    fetcher: (s) => fetchYearOverview(year, s),
    tables: ["expenses", "capital_entries"],
  });
  const ascending = useMemo(() => (data ? [...data.months].reverse() : []), [data]);
  const years = data ? Array.from(new Set([...data.years, year])).sort((a, b) => b - a) : [year];

  return (
    <section className="space-y-4" aria-label="Months">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Months</h2>
          <Select value={String(year)} onValueChange={(v) => set({ year: Number(v) === currentYear ? null : v })}>
            <SelectTrigger className="w-28" aria-label="Year"><SelectValue /></SelectTrigger>
            <SelectContent>{years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
          </Select>
          <FetchingIndicator show={isFetching && !isInitialLoading} />
        </div>
        <Button variant="outline" size="sm" asChild><Link href={`/finance/${year}`}>Full {year} report <ArrowRight /></Link></Button>
      </div>

      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : isInitialLoading || !data ? <ListSkeleton rows={4} /> : !data.months.length ? (
        <EmptyState title={`Nothing in ${year} yet`} description="Months appear here as the year goes on." />
      ) : (
        <div className={cn("space-y-4", isStale && "opacity-60")}>
          <ChartCard title={`${year} by month`} description="Capital and operating expenses side by side (not netted). Click a month to open its report.">
            <GroupedBars
              format={formatINRCompact}
              categories={ascending.map((m) => formatMonth(m.month))}
              series={[
                { name: "Expenses", values: ascending.map((m) => Number(m.expense)), color: SERIES[1] },
                { name: "Capital", values: ascending.map((m) => Number(m.capital)), color: SERIES[2] },
              ]}
              onItemClick={({ dataIndex }) => ascending[dataIndex] && router.push(`/finance/${ascending[dataIndex].month}`)}
            />
          </ChartCard>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.months.map((m, i) => (
              <MonthCard key={m.month} month={m} previousExpense={Number(i + 1 < data.months.length ? data.months[i + 1].expense : data.previous_december.expense)} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function MonthCard({ month: m, previousExpense }: { month: YearOverview["months"][number]; previousExpense: number }) {
  const expense = Number(m.expense);
  const capital = Number(m.capital);
  const delta = change(expense, previousExpense);
  const split = Object.entries(m.categories).map(([c, v]) => ({ c, v: Number(v ?? 0) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
  const empty = m.expense_entries === 0 && m.capital_entries === 0;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const label = formatMonthLong(m.month);
  return (
    <>
      {/* Clicking the card (or ⓘ) opens the details; → opens the full month report. The card-wide
          button sits under the header icons so no interactive element is nested in another. */}
      <Card size="sm" className="group relative h-full transition-colors hover:border-foreground/25">
        <button type="button" onClick={() => setDetailsOpen(true)} aria-label={`${label} details`}
          className="absolute inset-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" />
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">{label}</CardTitle>
            <div className="relative z-10 -mr-1.5 flex items-center">
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setDetailsOpen(true)} aria-label={`${label} details`} title="Details">
                <Info className="size-4 text-muted-foreground" />
              </Button>
              <Button variant="ghost" size="icon-sm" asChild>
                <Link href={`/finance/${m.month}`} aria-label={`${label} full report`} title="Full report">
                  <ArrowRight className="size-4 text-muted-foreground" />
                </Link>
              </Button>
            </div>
          </div>
          <CardDescription>{empty ? "No entries" : `${formatCount(m.expense_entries)} expenses · ${formatCount(m.capital_entries)} capital`}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">Expenses</span>
            <span className="font-semibold tabular-nums text-rose-400">{formatINR(expense)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground">Capital</span>
            <span className="font-semibold tabular-nums text-emerald-400">{formatINR(capital)}</span>
          </div>
          <p className={cn("flex items-center gap-1 text-xs", delta.up === true ? "text-rose-400" : delta.up === false ? "text-emerald-400" : "text-muted-foreground")}>
            {delta.up === true ? <TrendingUp className="size-3.5" /> : delta.up === false ? <TrendingDown className="size-3.5" /> : null}
            Expenses {delta.text} vs previous month
          </p>
          {split.length ? (
            <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" role="img"
              aria-label={`Category split: ${split.map((x) => `${x.c} ${formatINR(x.v)}`).join(", ")}`}>
              {split.map((x) => <span key={x.c} title={`${x.c}: ${formatINR(x.v)}`} style={{ width: `${(x.v / expense) * 100}%`, background: seriesColor(x.c) }} />)}
            </div>
          ) : null}
        </CardContent>
      </Card>
      <MonthDetailsDialog month={m} previousExpense={previousExpense} delta={delta} open={detailsOpen} onOpenChange={setDetailsOpen} />
    </>
  );
}

function FinanceStatCard({
  title,
  value,
  hint,
  tone,
  icon,
  badge,
}: {
  title: string;
  value: string | null;
  hint: string;
  tone: "success" | "danger";
  icon: React.ReactNode;
  badge: string;
}) {
  const isSuccess = tone === "success";
  return (
    <Card className="relative overflow-hidden border border-white/[0.08] bg-[#262626] shadow-md shadow-black/25 hover:border-white/[0.14] transition-all">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardDescription className="text-xs font-medium uppercase tracking-wider text-muted-foreground truncate">
            {title}
          </CardDescription>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide border shadow-2xs",
              isSuccess
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                : "border-rose-500/30 bg-rose-500/10 text-rose-400"
            )}
          >
            {icon}
            {badge}
          </span>
        </div>
        <CardTitle
          className={cn(
            "text-2xl font-bold tracking-tight tabular-nums mt-1",
            isSuccess ? "text-emerald-400" : "text-rose-400"
          )}
        >
          {value ?? <span className="inline-block h-8 w-36 animate-pulse rounded-lg bg-white/[0.08]" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground truncate">
        {hint}
      </CardContent>
    </Card>
  );
}
