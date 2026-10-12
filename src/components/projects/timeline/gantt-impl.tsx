"use client";

import { useEffect, useMemo, useState } from "react";
import * as echarts from "echarts/core";
import { CustomChart } from "echarts/charts";
import { DataZoomComponent, MarkLineComponent } from "echarts/components";
import EChartCore from "@/components/charts/echart-core";
import { useChartTheme } from "@/components/charts/chart";
import type { Phase, PhaseEvent } from "@/lib/projects";
import { ganttOption } from "./gantt-option";

echarts.use([CustomChart, MarkLineComponent, DataZoomComponent]);

export type GanttProps = {
  phases: Phase[];
  projectStart: string;
  projectEnd: string;
  /** The end date the project was created with; marked when the end moved. */
  originalEnd?: string;
  /** Status changes of the phases (oldest first); without them the track uses the actual dates. */
  history?: PhaseEvent[];
  /** IST date of today (kept for callers; the chart follows the clock). */
  today?: string;
  /** Visible window; defaults to the project with a little margin. */
  range?: { from: string; to: string };
  onOpen?: (phase: Phase) => void;
  /** Right-click: the phase row under the pointer (`heading` when on its stage name), or null. */
  onContextMenu?: (hit: GanttHit | null, e: React.MouseEvent) => void;
  /** Full screen: use the whole screen height. */
  fill?: boolean;
};

export type GanttHit = { phase: Phase; heading: boolean };

/** The project Gantt (see ganttOption for what each mark means). */
export default function GanttImpl({ phases, projectStart, projectEnd, originalEnd, history, range, onOpen, onContextMenu, fill }: GanttProps) {
  const theme = useChartTheme();
  // "Now" moves with the clock (the open stretches and the Now line), checked every minute.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const { option, phaseOf } = useMemo(
    () => ganttOption({ phases, projectStart, projectEnd, originalEnd, history, range, clock, theme }),
    [phases, projectStart, projectEnd, originalEnd, history, range, clock, theme],
  );

  // The row under a pixel: rows are evenly spaced bands around their centres. The stage name is the upper
  // line of the first row's label, left of the plot.
  const hitTest = ({ x, y }: { x: number; y: number }, chart: echarts.ECharts): GanttHit | null => {
    if (!phases.length) return null;
    const c0 = chart.convertToPixel({ yAxisIndex: 0 }, 0) as number;
    const band = phases.length > 1 ? (chart.convertToPixel({ yAxisIndex: 0 }, 1) as number) - c0 : 0;
    const i = band ? Math.round((y - c0) / band) : 0;
    if (i < 0 || i >= phases.length || (band && Math.abs(y - (c0 + i * band)) > Math.abs(band) / 2)) return null;
    const first = i === 0 || phases[i - 1].category !== phases[i].category;
    return { phase: phases[i], heading: first && y < c0 + i * band && !chart.containPixel("grid", [x, y]) };
  };

  // Fills the screen below the toolbar; long timelines grow past it (the page scrolls).
  const height = `max(${Math.max(phases.length * 40 + 96, 260)}px, calc(100dvh - ${fill ? "9rem" : "22rem"}))`;
  return (
    <EChartCore option={option} height={height} ariaLabel={`Project timeline with ${phases.length} phases, planned versus actual, with each phase's status history`}
      onItemClick={onOpen ? (c) => { const p = phaseOf(c.seriesName, c.dataIndex); if (p) onOpen(p); } : undefined}
      onContextMenu={onContextMenu ? (at, chart, e) => onContextMenu(hitTest(at, chart), e) : undefined} />
  );
}
