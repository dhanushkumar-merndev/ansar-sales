"use client";

import Link from "next/link";
import { ArrowRight, TrendingDown, TrendingUp } from "lucide-react";
import { seriesColor } from "@/components/charts/chart";
import { Donut } from "@/components/dashboard/widgets";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCount, formatINR } from "@/lib/format";
import type { YearOverview } from "@/lib/queries";
import { formatMonthLong } from "@/lib/time";
import { cn } from "@/lib/utils";

type Month = YearOverview["months"][number];

function previousMonthKey(month: string) {
  const [y, m] = month.slice(0, 7).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** One month's totals in detail, with an expense-category donut. The full report is one click further. */
export function MonthDetailsDialog({ month: m, previousExpense, delta, open, onOpenChange }: {
  month: Month;
  previousExpense: number;
  delta: { text: string; up: boolean | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const expense = Number(m.expense);
  const capital = Number(m.capital);
  const net = capital - expense;
  const categories = Object.entries(m.categories)
    .map(([c, v]) => ({ name: c, value: Number(v ?? 0), color: seriesColor(c) }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value);
  const top = categories[0];
  const label = formatMonthLong(m.month);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            {formatCount(m.expense_entries)} expense {m.expense_entries === 1 ? "entry" : "entries"} · {formatCount(m.capital_entries)} capital {m.capital_entries === 1 ? "entry" : "entries"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/[0.08] bg-background/40 p-3">
            <p className="text-xs text-muted-foreground">Expenses</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-rose-400">{formatINR(expense)}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {m.expense_entries ? `Avg ${formatINR(expense / m.expense_entries)} per entry` : "No expenses"}
            </p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-background/40 p-3">
            <p className="text-xs text-muted-foreground">Capital</p>
            <p className="mt-1 text-lg font-semibold tabular-nums text-emerald-400">{formatINR(capital)}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {m.capital_entries ? `${formatCount(m.capital_entries)} contribution${m.capital_entries === 1 ? "" : "s"}` : "No capital added"}
            </p>
          </div>
        </div>

        <dl className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.08] text-sm">
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <dt className="text-muted-foreground">vs {formatMonthLong(previousMonthKey(m.month))}</dt>
            <dd className={cn("flex items-center gap-1 tabular-nums", delta.up === true ? "text-rose-400" : delta.up === false ? "text-emerald-400" : "text-muted-foreground")}>
              {delta.up === true ? <TrendingUp className="size-3.5" /> : delta.up === false ? <TrendingDown className="size-3.5" /> : null}
              Expenses {delta.text}
              <span className="text-muted-foreground">({formatINR(previousExpense)})</span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <dt className="text-muted-foreground">Capital − expenses</dt>
            <dd className={cn("font-medium tabular-nums", net >= 0 ? "text-emerald-400" : "text-rose-400")}>
              {net >= 0 ? "+" : "−"}{formatINR(Math.abs(net))}
            </dd>
          </div>
          {top ? (
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <dt className="text-muted-foreground">Biggest category</dt>
              <dd className="tabular-nums">{top.name} · {Math.round((top.value / expense) * 100)}%</dd>
            </div>
          ) : null}
        </dl>

        <section aria-label="Expenses by category" className="space-y-2">
          <h3 className="text-sm font-medium">Expenses by category</h3>
          {categories.length
            ? <Donut items={categories} format={formatINR} totalLabel="Expenses" />
            : <p className="rounded-xl border border-dashed border-white/[0.1] py-8 text-center text-sm text-muted-foreground">No expenses this month.</p>}
        </section>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button asChild><Link href={`/finance/${m.month}`}>Open full report <ArrowRight /></Link></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
