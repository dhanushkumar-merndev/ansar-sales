// The Gantt's ECharts option, built without React or a browser (so it can be rendered in tests).
import type { EChartsCoreOption } from "echarts/core";
import type { CustomSeriesRenderItemAPI, CustomSeriesRenderItemParams, CustomSeriesRenderItemReturn } from "echarts";
import type { useChartTheme } from "@/components/charts/chart";
import { PHASE_STATUS_LABELS, type Phase, type PhaseEvent } from "@/lib/projects";
import { STAGE_HEX, type StageColor } from "@/lib/stages";
import { addDays, formatCalendarDate } from "@/lib/time";
import { STATUS_COLORS } from "./gantt-colors";
import { buildTrack, clusterChanges, DAY, duration, HOUR, IST, ts, when } from "./gantt-model";

const LATE = "#f87171";
const EXTENDED = "#fbbf24";
const TRACK = 4; // status line thickness; it grows on hover

export type GanttOptionInput = {
  phases: Phase[];
  projectStart: string;
  projectEnd: string;
  originalEnd?: string;
  history?: PhaseEvent[];
  range?: { from: string; to: string };
  /** Epoch ms of "now". */
  clock: number;
  theme: ReturnType<typeof useChartTheme>;
};

/**
 * Planned vs actual Gantt (one row per phase, grouped by stage):
 *   light bar   = planned start → deadline, in the phase colour
 *   thin line   = what actually happened: in progress, in review, changes requested; hovering a stretch thickens
 *                 it and shows just that stretch (from, to, how long, who)
 *   tick        = a status change, in the new status's colour; changes that would overlap at the current zoom
 *                 combine into one round marker with the count (its tooltip lists them)
 *   red line    = time past the deadline; red ring when the phase is overdue now
 *   dashed red  = now, with today's date and time on a tag at the top; dashed grey = project end; dotted amber = the planned end, when the end was moved
 * Zoom (scroll / the slider) goes down to hours.
 */
export function ganttOption({ phases, projectStart, projectEnd, originalEnd, history, range, clock, theme: t }: GanttOptionInput) {
  const now = clock + IST;
  const byPhase = new Map<string, PhaseEvent[]>();
  for (const e of history ?? []) byPhase.set(e.phase_id, [...(byPhase.get(e.phase_id) ?? []), e]);
  const tracks = phases.map((p) => buildTrack(p, byPhase.get(p.id) ?? [], now));
  const rows = phases.map((p, i) => [i, ts(p.planned_start), ts(p.deadline) + DAY, p.overdue ? 1 : 0]);
  const firstOfCategory = new Set<number>();
  phases.forEach((p, i) => { if (i === 0 || phases[i - 1].category !== p.category) firstOfCategory.add(i); });

  const bandGeometry = (api: CustomSeriesRenderItemAPI, i: number) => {
    const [, y] = api.coord([0, i]);
    const band = (api.size?.([0, 1]) as number[])[1];
    const h = Math.max(Math.min(band * 0.62, 26), 10);
    return { y, h, top: y - h / 2 };
  };

  // Series 0: the planned bar of each phase (+ late line, overdue ring, done tick). Hover: the phase summary.
  const renderPhase = (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI): CustomSeriesRenderItemReturn => {
    const i = api.value(0) as number;
    const p = phases[i];
    const tr = tracks[i];
    const hex = STAGE_HEX[p.color as StageColor] ?? STAGE_HEX.slate;
    const [x0] = api.coord([api.value(1), i]);
    const [x1] = api.coord([api.value(2), i]);
    const { y, h, top } = bandGeometry(api, i);
    const children: NonNullable<Extract<CustomSeriesRenderItemReturn, { type: "group" }>["children"]> = [
      { type: "rect", shape: { x: x0, y: top, width: Math.max(x1 - x0, 2), height: h, r: 4 }, style: { fill: `${hex}26`, stroke: `${hex}99`, lineWidth: 1, lineDash: [3, 2] },
        emphasis: { style: { fill: `${hex}40` } } },
    ];
    // Past the deadline: a red line under the bar, to the last activity (or now while it is still open).
    const lateEnd = p.overdue ? Math.max(now, tr.end ?? 0) : tr.end;
    if (lateEnd && lateEnd > (api.value(2) as number)) {
      const [lx] = api.coord([lateEnd, i]);
      children.push({ type: "rect", shape: { x: x1, y: top + h + 2, width: Math.max(lx - x1, 2), height: 2, r: 1 }, style: { fill: LATE } });
    }
    if (api.value(3) === 1) {
      children.push({ type: "rect", shape: { x: x0 - 1, y: top - 1, width: Math.max(x1 - x0, 2) + 2, height: h + 2, r: 5 }, style: { fill: "transparent", stroke: LATE, lineWidth: 1.5 } });
    }
    if (p.status === "done" || p.status === "skipped") {
      const [ex] = api.coord([Math.max(tr.end ?? 0, api.value(2) as number), i]);
      children.push({ type: "text", style: { text: p.status === "done" ? "✓" : "–", x: ex + 6, y, fill: STATUS_COLORS[p.status], fontSize: 12, verticalAlign: "middle", fontWeight: "bold" } });
    }
    return { type: "group", children };
  };

  // Series 1: one item per status stretch, so hovering shows (and thickens) just that stretch.
  const segments = tracks.flatMap((tr, i) => tr.segments.map((seg) => ({ i, seg })));
  const renderSegment = (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI): CustomSeriesRenderItemReturn => {
    const { i, seg } = segments[params.dataIndex];
    const [sx0] = api.coord([seg.from, i]);
    const [sx1] = api.coord([seg.to, i]);
    const { y } = bandGeometry(api, i);
    // Too short to see at this zoom: the combined tick of those changes stands in for it.
    const last = segments[params.dataIndex + 1]?.i !== i;
    if (sx1 - sx0 < 2 && !last) return null;
    // The hit area is a little taller than the line, so the thin line is easy to hover.
    return {
      type: "group", children: [
        { type: "rect", shape: { x: sx0, y: y - 6, width: Math.max(sx1 - sx0, 2), height: 12 }, style: { fill: "transparent" } },
        { type: "rect", shape: { x: sx0, y: y - TRACK / 2, width: Math.max(sx1 - sx0, 2), height: TRACK, r: TRACK / 2 },
          style: { fill: STATUS_COLORS[seg.status] }, originX: sx0, originY: y, emphasis: { scaleY: 2.75 } },
      ],
    };
  };

  // Series 2: one item per status change (a vertical tick in the new status's colour). Changes that would sit
  // closer than GAP pixels at the current zoom draw as one marker with a count; its tooltip lists them all.
  const marks = tracks.flatMap((tr, i) => tr.marks.map((m) => ({ i, m })));
  const marksOfPhase = phases.map(() => [] as number[]);
  marks.forEach(({ i }, k) => marksOfPhase[i].push(k));
  const GAP = 10;
  const view = { pxPerMs: 0 }; // the zoom scale of the last draw (the tooltip groups the same way)
  /** The group (global mark indices) that change k belongs to at the given scale. */
  const groupOf = (k: number, pxPerMs: number) => {
    const own = marksOfPhase[marks[k].i];
    const groups = clusterChanges(own.map((j) => marks[j].m.at), pxPerMs, GAP);
    return (groups.find((g) => g.some((n) => own[n] === k)) ?? [own.indexOf(k)]).map((n) => own[n]);
  };
  const renderMark = (params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI): CustomSeriesRenderItemReturn => {
    const k = params.dataIndex;
    const { i } = marks[k];
    view.pxPerMs = (api.coord([DAY, i])[0] - api.coord([0, i])[0]) / DAY;
    const group = groupOf(k, view.pxPerMs);
    if (group[0] !== k) return null; // drawn by the first change of its group (null removes any old shape)
    const { y, h, top } = bandGeometry(api, i);
    const latest = marks[group.at(-1)!].m;
    const color = STATUS_COLORS[latest.status];
    if (group.length === 1) {
      const [mx] = api.coord([marks[k].m.at, i]);
      return {
        type: "group", children: [
          { type: "rect", shape: { x: mx - 4, y: top - 3, width: 8, height: h + 6 }, style: { fill: "transparent" } },
          { type: "rect", shape: { x: mx - 1, y: top - 3, width: 2, height: h + 6, r: 1 }, style: { fill: color }, originX: mx, originY: y, emphasis: { scaleX: 1.75 } },
        ],
      };
    }
    // Several changes close together: one round marker with the count, centred on them.
    const xs = group.map((j) => api.coord([marks[j].m.at, i])[0]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const r = Math.min(Math.max(h / 2, 7), 9);
    return {
      type: "group", children: [
        { type: "circle", shape: { cx, cy: y, r }, style: { fill: color, stroke: t.surface, lineWidth: 1.5 }, originX: cx, originY: y, emphasis: { scaleX: 1.2, scaleY: 1.2 } },
        { type: "text", style: { text: String(group.length), x: cx, y, fill: "#0d0d0d", fontSize: 10, fontWeight: "bold", align: "center", verticalAlign: "middle" }, silent: true },
      ],
    };
  };

  const from = range?.from ?? addDays(projectStart, -2);
  const to = range?.to ?? addDays(projectEnd, 3);
  const pad = (n: number) => String(n).padStart(2, "0");
  const nowDate = new Date(now);
  const nowLabel = `${formatCalendarDate(nowDate.toISOString().slice(0, 10)).replace(/ \d{4}$/, "")}, ${pad(nowDate.getUTCHours())}:${pad(nowDate.getUTCMinutes())}`;
  const option: EChartsCoreOption = {
    animation: false,
    useUTC: true,
    // Room at the top for the dates and, under them, today's date on the Now line.
    grid: { left: 8, right: 16, top: 50, bottom: 44, containLabel: true },
    tooltip: {
      ...t.tooltip,
      trigger: "item",
      formatter: (info: { seriesIndex: number; dataIndex: number }) => {
        if (info.seriesIndex === 1) {
          const { i, seg } = segments[info.dataIndex];
          const lines = [
            `<span style="color:${STATUS_COLORS[seg.status]}">●</span> <b>${PHASE_STATUS_LABELS[seg.status]}</b> <span style="opacity:.7">${escapeHtml(phases[i].name)}</span>`,
            `${when(seg.fromAt, seg.from)} → ${seg.open ? "now" : when(seg.toAt, seg.to)}${seg.fromAt ? ` · ${duration(seg.to - seg.from)}` : ""}${seg.open ? " (still going)" : ""}`,
          ];
          if (seg.by) lines.push(`${seg.status === "changes_requested" ? "Asked by" : "By"} ${escapeHtml(seg.by)}`);
          return lines.join("<br/>");
        }
        if (info.seriesIndex === 2) {
          const group = view.pxPerMs ? groupOf(info.dataIndex, view.pxPerMs) : [info.dataIndex];
          const { i, m } = marks[group[0]];
          if (group.length === 1) {
            return [
              `<span style="color:${STATUS_COLORS[m.status]}">●</span> <b>${PHASE_STATUS_LABELS[m.status]}</b> <span style="opacity:.7">${escapeHtml(phases[i].name)}</span>`,
              `${when(m.iso, m.at)}${m.by ? ` · ${escapeHtml(m.by)}` : ""}`,
              m.was ? `<span style="opacity:.7">was ${PHASE_STATUS_LABELS[m.was]}</span>` : "",
            ].filter(Boolean).join("<br/>");
          }
          const first = marks[group[0]].m, last = marks[group.at(-1)!].m;
          return [
            `<b>${group.length} changes</b> <span style="opacity:.7">${escapeHtml(phases[i].name)} · within ${duration(last.at - first.at)} · zoom in to see them apart</span>`,
            ...group.map((j) => {
              const c = marks[j].m;
              return `<span style="color:${STATUS_COLORS[c.status]}">●</span> ${PHASE_STATUS_LABELS[c.status]} · ${when(c.iso, c.at)}${c.by ? ` · ${escapeHtml(c.by)}` : ""}`;
            }),
          ].join("<br/>");
        }
        const p = phases[info.dataIndex];
        if (!p) return "";
        const lines = [
          `<b>${escapeHtml(p.name)}</b> <span style="opacity:.7">${escapeHtml(p.category)}</span>`,
          `Planned: ${formatCalendarDate(p.planned_start)} → ${formatCalendarDate(p.deadline)}`,
          `Now: ${PHASE_STATUS_LABELS[p.status]}${p.owner ? ` · ${escapeHtml(p.owner.display_name)}` : ""}`,
        ];
        if (p.late_days > 0) lines.push(`<span style="color:${LATE}">${p.overdue ? `${p.late_days} days late` : `Submitted ${p.late_days} days late`}</span>`);
        const changes = tracks[info.dataIndex].marks.length;
        if (changes) lines.push(`<span style="opacity:.7">${changes} status change${changes === 1 ? "" : "s"} · hover the coloured line for each</span>`);
        return lines.join("<br/>");
      },
    },
    xAxis: {
      type: "time", position: "top", min: ts(from), max: ts(to) + DAY, minInterval: HOUR,
      ...t.axis,
      axisLabel: {
        ...t.axis.axisLabel, hideOverlap: true, margin: 26,
        // Days at midnight, hours in between (zoomed in).
        formatter: (v: number) => {
          const d = new Date(v);
          if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return `{day|${formatCalendarDate(d.toISOString().slice(0, 10)).replace(/ \d{4}$/, "")}}`;
          return `{time|${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}}`;
        },
        rich: { day: { color: t.text, fontSize: 11 }, time: { color: t.muted, fontSize: 10 } },
      },
      splitLine: { show: true, lineStyle: { color: t.grid } },
    },
    yAxis: {
      type: "category", inverse: true, data: phases.map((p) => p.id),
      axisLine: { show: false }, axisTick: { show: false },
      splitArea: { show: true, areaStyle: { color: ["transparent", t.shade] } },
      axisLabel: {
        color: t.text, fontSize: 12, width: 190, overflow: "truncate",
        formatter: (_: string, i: number) => {
          const p = phases[i];
          return firstOfCategory.has(i) ? `{cat|${p.category.toUpperCase()}}\n{name|${p.name}}` : `{name|${p.name}}`;
        },
        rich: { cat: { color: t.muted, fontSize: 10, fontWeight: "bold", lineHeight: 14 }, name: { color: t.text, fontSize: 12, lineHeight: 16 } },
      },
    },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "weakFilter", minValueSpan: 3 * HOUR },
      { type: "slider", xAxisIndex: 0, height: 18, bottom: 8, filterMode: "weakFilter", minValueSpan: 3 * HOUR, borderColor: t.border, textStyle: { color: t.muted }, labelFormatter: () => "" },
    ],
    series: [{
      type: "custom",
      name: "phases",
      renderItem: renderPhase,
      encode: { x: [1, 2], y: 0 },
      data: rows,
      clip: true,
      markLine: {
        silent: true, symbol: "none", animation: false,
        data: [
          // The axis is inverted, so the line starts at the top: today's date (and time) sits there as a tag.
          { xAxis: now, lineStyle: { color: LATE, type: "dashed", width: 1.5 },
            label: { formatter: `Now · ${nowLabel}`, position: "start", distance: 4, color: "#fff", backgroundColor: LATE, fontSize: 10, fontWeight: "bold", padding: [3, 6], borderRadius: 4 } },
          { xAxis: ts(projectEnd) + DAY, lineStyle: { color: t.muted, type: "dashed", width: 1 }, label: { formatter: originalEnd && originalEnd !== projectEnd ? "New end" : "End", color: t.muted, fontSize: 10, position: "end" } },
          ...(originalEnd && originalEnd !== projectEnd ? [{ xAxis: ts(originalEnd) + DAY, lineStyle: { color: EXTENDED, type: "dotted" as const, width: 1.5 },
            label: { formatter: "Planned end", color: EXTENDED, fontSize: 10, position: "end" as const } }] : []),
        ],
      },
    }, {
      type: "custom",
      name: "status",
      renderItem: renderSegment,
      encode: { x: [1, 2], y: 0 },
      data: segments.map(({ i, seg }) => [i, seg.from, seg.to]),
      clip: true, z: 3,
    }, {
      type: "custom",
      name: "changes",
      renderItem: renderMark,
      encode: { x: 1, y: 0 },
      data: marks.map(({ i, m }) => [i, m.at]),
      clip: true, z: 4,
    }],
  };
  // A click anywhere on a row (bar, stretch or tick) opens that phase.
  const phaseOf = (series: string | undefined, index: number) =>
    phases[series === "status" ? segments[index]?.i : series === "changes" ? marks[index]?.i : index];
  return { option, phaseOf };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
