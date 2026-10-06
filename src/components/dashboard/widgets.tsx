"use client";

import { useMemo } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { EChart, GRID, SERIES, useChartTheme } from "@/components/charts/chart";
import type { ChartClick } from "@/components/charts/echart-core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

export function StatCard({ label, value, hint, tone, icon }: { label: string; value: string | null; hint?: string; tone?: "danger" | "success"; icon?: React.ReactNode }) {
  return (
    <Card size="sm" className="relative overflow-hidden">
      <CardHeader>
        <div className="flex items-center justify-between gap-1">
          <CardDescription className="text-xs font-medium uppercase tracking-wider">{label}</CardDescription>
          {tone === "success" ? (
            <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <TrendingUp className="size-3" />
            </span>
          ) : tone === "danger" ? (
            <span className="flex size-5 items-center justify-center rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">
              <TrendingDown className="size-3" />
            </span>
          ) : icon ? (
            <span className="text-muted-foreground">{icon}</span>
          ) : null}
        </div>
        <CardTitle className={cn("text-2xl font-bold tracking-tight tabular-nums mt-0.5", tone === "danger" && "text-rose-400", tone === "success" && "text-emerald-400")}>
          {value ?? <Skeleton className="h-7 w-16" />}
        </CardTitle>
      </CardHeader>
      {hint ? <CardContent className="-mt-2 text-xs text-muted-foreground">{hint}</CardContent> : null}
    </Card>
  );
}

export function ChartCard({ title, description, children, className }: { title: string; description: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Fixed-height table inside a card: the rows scroll, the header stays visible. */
export function ScrollTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="[&_[data-slot=table-container]]:max-h-96 [&_[data-slot=table-container]]:overflow-y-auto [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card [&_thead]:shadow-[inset_0_-1px_0_var(--border)]">
      {children}
    </div>
  );
}

/** Single-series daily line (one hue, crosshair tooltip, no legend needed). */
export function TrendLine({ points, label, format = formatCount, dateLabel }: {
  points: { x: string; y: number }[]; label: string; format?: (n: number) => string; dateLabel: (x: string) => string;
}) {
  const ct = useChartTheme();
  const option = useMemo(() => ({
    grid: GRID,
    tooltip: { ...ct.tooltip, trigger: "axis", axisPointer: { type: "line", lineStyle: { color: ct.pointer } },
      valueFormatter: (v: number) => format(v) },
    xAxis: { type: "category", data: points.map((p) => dateLabel(p.x)), boundaryGap: false, ...ct.axis, splitLine: { show: false } },
    yAxis: { type: "value", minInterval: 1, ...ct.axis },
    series: [{ name: label, type: "line", data: points.map((p) => p.y), smooth: false, showSymbol: false, symbolSize: 8,
      lineStyle: { width: 2, color: SERIES[0] }, itemStyle: { color: SERIES[0] }, areaStyle: { color: "rgba(57,135,229,0.12)" } }],
  }), [points, label, format, dateLabel, ct]);
  return <EChart option={option} height={240} ariaLabel={`${label} line chart`} />;
}

/** Vertical bars for one measure per category (rounded data-ends, per-bar tooltip). */
export function Bars({ items, label, format = formatCount, horizontal }: {
  items: { name: string; value: number }[]; label: string; format?: (n: number) => string; horizontal?: boolean;
}) {
  const ct = useChartTheme();
  const option = useMemo(() => {
    const cat = { type: "category", data: items.map((i) => i.name), ...ct.axis, splitLine: { show: false } };
    const val = { type: "value", ...ct.axis, axisLabel: { ...ct.axis.axisLabel, formatter: (v: number) => format(v) } };
    return {
      grid: GRID,
      tooltip: { ...ct.tooltip, trigger: "item", valueFormatter: (v: number) => format(v) },
      xAxis: horizontal ? val : cat,
      yAxis: horizontal ? { ...cat, inverse: true } : val,
      series: [{ name: label, type: "bar", data: items.map((i) => i.value), barMaxWidth: 28,
        itemStyle: { color: SERIES[0], borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] } }],
    };
  }, [items, label, format, horizontal, ct]);
  return <EChart option={option} height={horizontal ? Math.max(160, items.length * 34) : 240} ariaLabel={`${label} bar chart`} />;
}

/** Grouped (or stacked) bars for a few series per category; legend always present. */
export function GroupedBars({ categories, series, stacked, format = formatCount, height = 260, onItemClick }: {
  categories: string[]; series: { name: string; values: number[]; color?: string }[]; stacked?: boolean; format?: (n: number) => string; height?: number;
  onItemClick?: (item: ChartClick) => void;
}) {
  const ct = useChartTheme();
  const option = useMemo(() => ({
    grid: { ...GRID, top: 36 },
    legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: ct.muted } },
    tooltip: { ...ct.tooltip, trigger: "axis", axisPointer: { type: "shadow", shadowStyle: { color: ct.shade } }, valueFormatter: (v: number) => format(v) },
    xAxis: { type: "category", data: categories, ...ct.axis, splitLine: { show: false } },
    yAxis: { type: "value", minInterval: 1, ...ct.axis, axisLabel: { ...ct.axis.axisLabel, formatter: (v: number) => format(v) } },
    series: series.map((s, i) => ({
      name: s.name, type: "bar", data: s.values, barMaxWidth: stacked ? 28 : 18, barGap: "15%", stack: stacked ? "total" : undefined,
      itemStyle: { color: s.color ?? SERIES[i], borderRadius: stacked ? 0 : [4, 4, 0, 0], borderColor: ct.surface, borderWidth: 1 },
    })),
  }), [categories, series, stacked, format, ct]);
  return <EChart option={option} height={height} ariaLabel={stacked ? "Stacked bar chart" : "Comparison bar chart"} onItemClick={onItemClick} />;
}

/** A few lines over the same periods; legend always present. `area` fills under a single cumulative series. */
export function MultiLine({ categories, series, format = formatCount, area }: {
  categories: string[]; series: { name: string; values: number[]; color?: string }[]; format?: (n: number) => string; area?: boolean;
}) {
  const ct = useChartTheme();
  const option = useMemo(() => ({
    grid: { ...GRID, top: 36 },
    legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: ct.muted } },
    tooltip: { ...ct.tooltip, trigger: "axis", axisPointer: { type: "line", lineStyle: { color: ct.pointer } }, valueFormatter: (v: number) => format(v) },
    xAxis: { type: "category", data: categories, boundaryGap: false, ...ct.axis, splitLine: { show: false } },
    yAxis: { type: "value", minInterval: 1, ...ct.axis, axisLabel: { ...ct.axis.axisLabel, formatter: (v: number) => format(v) } },
    series: series.map((s, i) => ({
      name: s.name, type: "line", data: s.values, showSymbol: categories.length <= 16, symbolSize: 6,
      lineStyle: { width: 2, color: s.color ?? SERIES[i] }, itemStyle: { color: s.color ?? SERIES[i] },
      areaStyle: area ? { color: s.color ?? SERIES[i], opacity: 0.12 } : undefined,
    })),
  }), [categories, series, format, area, ct]);
  return <EChart option={option} height={260} ariaLabel={`${series.map((s) => s.name).join(", ")} line chart`} />;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Weekday × hour (IST) counts; one sequential hue, values in the tooltip. */
export function WeekHourHeatmap({ cells, label }: { cells: { dow: number; hour: number; count: number }[]; label: string }) {
  const ct = useChartTheme();
  const max = Math.max(1, ...cells.map((c) => c.count));
  const option = useMemo(() => ({
    grid: { ...GRID, left: 4, bottom: 36 },
    tooltip: { ...ct.tooltip, trigger: "item",
      formatter: (p: { value: [number, number, number] }) => `${WEEKDAYS[p.value[1]]} ${String(p.value[0]).padStart(2, "0")}:00 IST<br/><b>${formatCount(p.value[2])}</b> ${label}` },
    xAxis: { type: "category", data: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")), ...ct.axis, splitArea: { show: false } },
    yAxis: { type: "category", data: WEEKDAYS, inverse: true, ...ct.axis },
    visualMap: { min: 0, max, calculable: false, orient: "horizontal", left: "center", bottom: 0, itemHeight: 120, itemWidth: 10,
      textStyle: { color: ct.muted, fontSize: 11 }, inRange: { color: [ct.grid, SERIES[0]] } },
    series: [{ type: "heatmap", data: cells.map((c) => [c.hour, c.dow - 1, c.count]),
      itemStyle: { borderColor: ct.surface, borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: ct.text } } }],
  }), [cells, max, label, ct]);
  return <EChart option={option} height={280} ariaLabel={`${label} by weekday and hour heatmap`} />;
}

/** Stage funnel with the count and share of the first stage on every step. */
export function Funnel({ steps }: { steps: { name: string; value: number }[] }) {
  const ct = useChartTheme();
  const first = steps[0]?.value ?? 0;
  const option = useMemo(() => ({
    tooltip: { ...ct.tooltip, trigger: "item", formatter: (p: { name: string; value: number }) => `${p.name}: <b>${formatCount(p.value)}</b>` },
    series: [{
      type: "funnel", sort: "none", left: 8, right: 8, top: 4, bottom: 4, minSize: "12%", gap: 3,
      label: { show: true, position: "inside", color: "#fff", fontSize: 12,
        formatter: (p: { name: string; value: number }) => `${p.name}  ${formatCount(p.value)}${first ? ` · ${Math.round((p.value / first) * 100)}%` : ""}` },
      itemStyle: { borderColor: ct.surface, borderWidth: 1 },
      data: steps.map((s, i) => ({ name: s.name, value: s.value, itemStyle: { color: SERIES[i % SERIES.length] } })),
    }],
  }), [steps, first, ct]);
  if (first === 0) return <p className="py-10 text-center text-sm text-muted-foreground">No leads in this range.</p>;
  return <EChart option={option} height={260} ariaLabel="Lead stage funnel" />;
}

/** Donut with a labelled legend table (identity never by color alone; values always visible). */
export function Donut({ items, format = formatCount, totalLabel }: {
  items: { name: string; value: number; color: string }[]; format?: (n: number) => string; totalLabel: string;
}) {
  const total = items.reduce((s, i) => s + i.value, 0);
  const ct = useChartTheme();
  const option = useMemo(() => ({
    tooltip: { ...ct.tooltip, trigger: "item", valueFormatter: (v: number) => format(v) },
    series: [{
      type: "pie", radius: ["58%", "82%"], padAngle: 1, label: { show: false },
      itemStyle: { borderColor: ct.surface, borderWidth: 2, borderRadius: 4 },
      data: items.filter((i) => i.value > 0).map((i) => ({ name: i.name, value: i.value, itemStyle: { color: i.color } })),
    }],
  }), [items, format, ct]);
  if (total === 0) return <p className="py-10 text-center text-sm text-muted-foreground">No data yet.</p>;
  return (
    <div className="grid items-center gap-4 sm:grid-cols-[180px_1fr]">
      <div className="relative">
        <EChart option={option} height={180} ariaLabel={`${totalLabel} donut chart`} />
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums">{format(total)}</span>
          <span className="text-[11px] text-muted-foreground">{totalLabel}</span>
        </div>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {items.map((i) => (
            <tr key={i.name} className="border-b last:border-0">
              <td className="py-1.5"><span className="mr-2 inline-block size-2.5 rounded-sm align-middle" style={{ background: i.color }} />{i.name}</td>
              <td className="py-1.5 text-right tabular-nums">{format(i.value)}</td>
              <td className="w-12 py-1.5 text-right text-xs text-muted-foreground tabular-nums">{total ? Math.round((i.value / total) * 100) : 0}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
