"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, FunnelChart, HeatmapChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";

echarts.use([BarChart, FunnelChart, HeatmapChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent, SVGRenderer]);

export type ChartClick = { dataIndex: number; name: string; seriesName?: string };

/** Client-only ECharts instance with resize handling and disposal. `onItemClick` makes data items clickable. */
export default function EChartCore({ option, height, ariaLabel, onItemClick }: {
  option: EChartsCoreOption; height: number; ariaLabel: string; onItemClick?: (item: ChartClick) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onItemClick);
  useEffect(() => {
    clickRef.current = onItemClick;
  }, [onItemClick]);

  useEffect(() => {
    if (!ref.current) return;
    const instance = echarts.init(ref.current, undefined, { renderer: "svg" });
    chart.current = instance;
    instance.on("click", (p) => clickRef.current?.({ dataIndex: p.dataIndex, name: p.name, seriesName: p.seriesName }));
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  return <div ref={ref} role="img" aria-label={ariaLabel} style={{ height, width: "100%", cursor: onItemClick ? "pointer" : undefined }} />;
}
