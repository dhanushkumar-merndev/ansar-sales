"use client";

import { useContext, useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, FunnelChart, HeatmapChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";
import { ChartMotion } from "./chart-motion";

echarts.use([BarChart, FunnelChart, HeatmapChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent, SVGRenderer]);

export type ChartClick = { dataIndex: number; name: string; seriesName?: string };

/**
 * Client-only ECharts instance with resize handling and disposal. `onItemClick` makes data items clickable;
 * `onContextMenu` gets right-clicks with the point inside the chart (it may preventDefault the event).
 */
export default function EChartCore({ option, height, ariaLabel, onItemClick, onContextMenu }: {
  /** Pixels, or any CSS height (e.g. "max(320px, calc(100dvh - 20rem))"). */
  option: EChartsCoreOption; height: number | string; ariaLabel: string; onItemClick?: (item: ChartClick) => void;
  onContextMenu?: (at: { x: number; y: number }, chart: echarts.ECharts, e: React.MouseEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onItemClick);
  const motion = useContext(ChartMotion);
  const drawn = useRef(false);
  useEffect(() => {
    clickRef.current = onItemClick;
  }, [onItemClick]);

  useEffect(() => {
    if (!ref.current) return;
    const instance = echarts.init(ref.current, undefined, { renderer: "svg" });
    chart.current = instance;
    drawn.current = false; // a new instance builds in again (also under Strict Mode's double effects)
    instance.on("click", (p) => clickRef.current?.({ dataIndex: p.dataIndex, name: p.name, seriesName: p.seriesName }));
    // Resize only on a real size change: ResizeObserver also fires once right after observe(), and a
    // resize() then would cut the chart's entry animation short.
    const el = ref.current;
    let size = `${el.clientWidth}x${el.clientHeight}`;
    const ro = new ResizeObserver(() => {
      const next = `${el.clientWidth}x${el.clientHeight}`;
      if (next === size) return;
      size = next;
      instance.resize();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    // Respect the OS "reduce motion" setting (charts otherwise animate in).
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let next: EChartsCoreOption = option;
    if (reduce) next = { ...option, animation: false };
    else if (motion && !drawn.current) {
      // Timed build (presentation): wait for the panel to appear, then build in order.
      // Set per series: series defaults override the chart-wide animation settings. Only bars build
      // item by item; lines, donuts and funnels animate as one piece.
      const raw = (option as { series?: unknown }).series;
      const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Record<string, unknown>[];
      next = {
        ...option,
        series: list.map((s, n) => ({
          ...s, animationDuration: s.type === "line" ? 1200 : 900, animationEasing: "cubicOut",
          animationDelay: s.type === "bar" ? (i: number) => motion.delay + n * 60 + Math.min(i, 30) * 25 : motion.delay,
        })),
      };
    }
    if (chart.current) {
      chart.current.setOption(next, { notMerge: true });
      drawn.current = true;
    }
  }, [option, motion]);

  return (
    <div ref={ref} role="img" aria-label={ariaLabel} style={{ height, width: "100%", cursor: onItemClick ? "pointer" : undefined }}
      onContextMenu={onContextMenu ? (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        if (chart.current) onContextMenu({ x: e.clientX - r.left, y: e.clientY - r.top }, chart.current, e);
      } : undefined} />
  );
}
