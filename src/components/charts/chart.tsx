"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";
import { Skeleton } from "@/components/ui/skeleton";

/** Lazily loaded so ECharts never ships in the initial bundle or renders on the server. */
export const EChart = dynamic(() => import("./echart-core"), {
  ssr: false,
  loading: () => <Skeleton className="h-[260px] w-full" />,
});

// Validated categorical order (dataviz reference palette, dark steps; all six checks pass on #212121). Assigned by entity, never cycled.
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"] as const;
const EXTRA = ["#8b5cf6", "#0ea5e9", "#f97316", "#64748b", "#14b8a6", "#e11d48"] as const;
const NAMED_SERIES = [...SERIES, ...EXTRA];

/** A stable colour for a named series (e.g. an expense category): the same name always gets the same colour. */
export function seriesColor(name: string) {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NAMED_SERIES[h % NAMED_SERIES.length];
}

const PALETTE = {
  light: { surface: "#ffffff", text: "#0d0d0d", muted: "#5d5d5d", grid: "#ececec", border: "#e5e5e5", pointer: "#8f8f8f", shade: "rgba(0,0,0,0.04)", shadow: "rgba(0,0,0,.08)" },
  dark: { surface: "#212121", text: "#ececec", muted: "#a3a3a3", grid: "#ffffff14", border: "#ffffff1a", pointer: "#6b6b6b", shade: "rgba(255,255,255,0.05)", shadow: "rgba(0,0,0,.4)" },
} as const;

/** Axis/tooltip/surface styling for the active light or dark theme. */
export function useChartTheme() {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return useMemo(() => {
    const c = dark ? PALETTE.dark : PALETTE.light;
    return {
      ...c,
      axis: {
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: c.muted, fontSize: 11 },
        splitLine: { lineStyle: { color: c.grid } },
      },
      tooltip: {
        backgroundColor: c.surface,
        borderColor: c.border,
        textStyle: { color: c.text, fontSize: 12 },
        extraCssText: `box-shadow:0 4px 16px ${c.shadow};border-radius:12px;`,
      },
    };
  }, [dark]);
}

export const GRID = { left: 8, right: 12, top: 16, bottom: 4, containLabel: true } as const;
