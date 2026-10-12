import { describe, expect, it } from "vitest";
import * as echarts from "echarts/core";
import { CustomChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { ganttOption } from "@/components/projects/timeline/gantt-option";
import type { Phase, PhaseEvent } from "@/lib/projects";

// Renders the real Gantt option with ECharts (server-side SVG, no browser) and records what each item draws,
// so the status track, the ticks and their combining are checked at real pixel positions.
echarts.use([CustomChart, MarkLineComponent, DataZoomComponent, GridComponent, TooltipComponent, SVGRenderer]);

const theme = {
  surface: "#212121", text: "#ececec", muted: "#a3a3a3", grid: "#ffffff14", border: "#ffffff1a", pointer: "#6b6b6b", shade: "rgba(255,255,255,0.05)", shadow: "rgba(0,0,0,.4)",
  axis: { axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: "#a3a3a3", fontSize: 11 }, splitLine: { lineStyle: { color: "#ffffff14" } } },
  tooltip: { backgroundColor: "#212121", borderColor: "#ffffff1a", textStyle: { color: "#ececec", fontSize: 12 }, extraCssText: "", confine: true },
} as unknown as Parameters<typeof ganttOption>[0]["theme"];

const base = { status: "not_started", actual_start: null, submitted_on: null, overdue: false, late_days: 0, owner: null, items: [], position: 1, color: "sky", needs_client_approval: false } as const;
const phases = [
  { ...base, id: "a", name: "First cut design & estimation — R0", category: "Design", status: "changes_requested", planned_start: "2026-10-07", deadline: "2026-10-09", actual_start: "2026-10-07" },
  { ...base, id: "b", name: "Design development", category: "Design", planned_start: "2026-10-10", deadline: "2026-10-15" },
] as unknown as Phase[];
// The live project's three changes: 16:00, 16:03 and 16:11 IST.
const history: PhaseEvent[] = [
  { phase_id: "a", at: "2026-10-07T10:30:16Z", from: "not_started", to: "in_progress", by: "Diny" },
  { phase_id: "a", at: "2026-10-07T10:33:48Z", from: "in_progress", to: "in_review", by: "Diny" },
  { phase_id: "a", at: "2026-10-07T10:41:48Z", from: "in_review", to: "changes_requested", by: "Raj" },
];
const CLOCK = Date.parse("2026-10-07T12:00:00Z");
const IST = 5.5 * 3_600_000;

type Drawn = { type: string; children?: { type: string; style?: { text?: string } }[] } | null;

/** Draws the chart (optionally zoomed to [from, to] IST wall-clock ms) and returns what series 1 and 2 drew per item. */
function draw(zoom?: [number, number]) {
  const { option } = ganttOption({ phases, projectStart: "2026-10-05", projectEnd: "2026-11-30", history, clock: CLOCK, theme });
  const o = option as { series: { renderItem: (...a: unknown[]) => Drawn }[]; dataZoom: Record<string, unknown>[]; tooltip: { formatter: (i: unknown) => string } };
  const drawn: Drawn[][] = [[], [], []];
  o.series.forEach((s, n) => {
    const real = s.renderItem;
    s.renderItem = (params, api) => {
      const out = real(params, api);
      drawn[n][(params as { dataIndex: number }).dataIndex] = out;
      return out;
    };
  });
  if (zoom) o.dataZoom = o.dataZoom.map((d) => ({ ...d, startValue: zoom[0], endValue: zoom[1] }));
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 1200, height: 400 });
  chart.setOption(option);
  const svg = chart.renderToSVGString();
  const tip = (seriesIndex: number, dataIndex: number) => o.tooltip.formatter({ seriesIndex, dataIndex });
  chart.dispose();
  return { segments: drawn[1], marks: drawn[2], svg, tip };
}

const texts = (d: Drawn) => (d?.children ?? []).filter((c) => c.type === "text").map((c) => c.style?.text);

describe("Gantt rendering", () => {
  it("combines the three close changes into one marker with a count at the whole-project zoom", () => {
    const { marks, segments, tip, svg } = draw();
    expect(marks).toHaveLength(3);
    expect(marks[0]?.children?.map((c) => c.type)).toEqual(["circle", "text"]);
    expect(texts(marks[0])).toEqual(["3"]);
    expect(marks[1]).toBeNull(); // nothing left behind for the combined ones
    expect(marks[2]).toBeNull();
    // The tiny in-progress and in-review stretches are hidden; the open one still shows under the marker.
    expect(segments[0]).toBeNull();
    expect(segments[1]).toBeNull();
    expect(segments[2]).not.toBeNull();
    const t = tip(2, 0);
    expect(t).toContain("3 changes");
    expect(t).toContain("In progress");
    expect(t).toContain("In review");
    expect(t).toContain("Changes requested");
    expect(svg).toContain("<svg");
  });

  it("shows each change as its own tick, and each stretch on its own, when zoomed in to hours", () => {
    const from = Date.parse("2026-10-07T10:20:00Z") + IST, to = Date.parse("2026-10-07T10:50:00Z") + IST;
    const { marks, segments, tip } = draw([from, to]);
    expect(marks.every((m) => m?.children?.some((c) => c.type === "rect"))).toBe(true);
    expect(marks.flatMap(texts)).toEqual([]);
    expect(segments.every((s) => s !== null)).toBe(true);
    // Hovering a stretch tells only about that stretch.
    const review = tip(1, 1);
    expect(review).toContain("In review");
    expect(review).toContain("8 min");
    expect(review).not.toContain("Changes requested");
    expect(review).not.toContain("In progress");
    // Hovering a tick tells only about that change.
    const change = tip(2, 2);
    expect(change).toContain("Changes requested");
    expect(change).toContain("Raj");
    expect(change).not.toContain("changes</b>");
  });

  it("leaves nothing behind when zooming back out (the stray violet tick)", () => {
    const { option } = ganttOption({ phases, projectStart: "2026-10-05", projectEnd: "2026-11-30", history, clock: CLOCK, theme });
    const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 1200, height: 400 });
    chart.setOption(option);
    const violet = () => (chart.renderToSVGString().match(/#a78bfa/gi) ?? []).length; // the in-review colour
    const zoom = (from: string, to: string) => chart.dispatchAction({ type: "dataZoom", startValue: Date.parse(from) + IST, endValue: Date.parse(to) + IST });
    zoom("2026-10-07T10:20:00Z", "2026-10-07T10:50:00Z");
    expect(violet()).toBeGreaterThan(0); // in review shows on its own when zoomed in
    zoom("2026-10-03T00:00:00Z", "2026-12-03T00:00:00Z");
    expect(violet()).toBe(0); // zoomed out: only the combined marker (in the latest status's colour)
    chart.dispose();
  });

  it("draws phases without any history or start without errors", () => {
    const { option } = ganttOption({ phases: [phases[1]], projectStart: "2026-10-05", projectEnd: "2026-11-30", clock: CLOCK, theme });
    const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 800, height: 300 });
    expect(() => chart.setOption(option)).not.toThrow();
    chart.dispose();
  });
});
