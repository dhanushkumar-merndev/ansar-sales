// The Gantt's data model, kept free of ECharts so it can be unit-tested.
import type { Phase, PhaseEvent, PhaseStatus } from "@/lib/projects";
import { formatCalendarDate, formatDateTime } from "@/lib/time";

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const IST = 5.5 * HOUR;
// The chart runs on IST wall-clock time shown as UTC (useUTC), so day and hour ticks fall on IST
// midnights and hours whatever the browser's timezone.
export const ts = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const wall = (iso: string) => Date.parse(iso) + IST;
export const OPEN: PhaseStatus[] = ["in_progress", "in_review", "changes_requested"];

/** One stretch of a status. Times are IST wall-clock ms; the ISO times are for the tooltip (null = only the date is known). */
export type Segment = { from: number; to: number; status: PhaseStatus; fromAt: string | null; toAt: string | null; open: boolean; by: string | null };
/** One status change. */
export type Mark = { at: number; status: PhaseStatus; was: PhaseStatus | null; iso: string | null; by: string | null };
export type Track = { segments: Segment[]; marks: Mark[]; end: number | null; events: PhaseEvent[] };

/** The phase's status over time: one coloured stretch per status, a tick at each change. */
export function buildTrack(p: Phase, events: PhaseEvent[], now: number): Track {
  const segments: Segment[] = [];
  const marks: Mark[] = [];
  if (events.length) {
    events.forEach((e, i) => {
      const next = events[i + 1];
      const from = wall(e.at);
      const open = !next && OPEN.includes(e.to);
      const to = next ? wall(next.at) : open ? now : from;
      marks.push({ at: from, status: e.to, was: e.from, iso: e.at, by: e.by });
      if (OPEN.includes(e.to) && to > from) segments.push({ from, to, status: e.to, fromAt: e.at, toAt: next?.at ?? null, open, by: e.by });
    });
  } else if (p.actual_start) {
    // Older phases without a recorded history: started → submitted (or now), then the current status.
    // Only dates are known: started and submitted on the same day split that day in half.
    const a = ts(p.actual_start);
    const subDay = p.submitted_on ? ts(p.submitted_on) : null;
    const sub = subDay === null ? null : subDay > a ? subDay : a + Math.max(Math.min(now, a + DAY) - a, HOUR) / 2;
    const openNow = sub === null && OPEN.includes(p.status);
    segments.push({ from: a, to: sub ?? (openNow ? now : a + DAY), status: "in_progress", fromAt: null, toAt: null, open: openNow, by: null });
    marks.push({ at: a, status: "in_progress", was: "not_started", iso: null, by: null });
    if (sub !== null && (p.status === "in_review" || p.status === "changes_requested")) {
      segments.push({ from: sub, to: Math.max(now, sub + HOUR), status: p.status, fromAt: null, toAt: null, open: true, by: null });
    }
    if (sub !== null) marks.push({ at: sub, status: p.status === "in_progress" ? "in_review" : p.status, was: "in_progress", iso: null, by: null });
  }
  const end = segments.length ? Math.max(...segments.map((x) => x.to), ...marks.map((m) => m.at)) : marks.at(-1)?.at ?? null;
  return { segments, marks, end, events };
}

/** "8 min", "3 h 20 min", "2 days 4 h". */
export function duration(ms: number) {
  const min = Math.max(Math.round(ms / 60_000), 1);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d} day${d === 1 ? "" : "s"} ${rh} h` : `${d} day${d === 1 ? "" : "s"}`;
}
/** IST wall-clock ms back to a readable date (and time when it is known). */
export const when = (iso: string | null, wallMs: number) => (iso ? formatDateTime(iso) : formatCalendarDate(new Date(wallMs).toISOString().slice(0, 10)));

/**
 * Groups status changes that would sit closer than `gapPx` pixels at the current zoom, so they draw as one
 * marker with a count. `times` are ascending; a group starts at its first change and takes every later change
 * within `gapPx` of that first one (anchored, so a long run of changes never turns into one wide block).
 * Returns the groups as index lists into `times`.
 */
export function clusterChanges(times: number[], pxPerMs: number, gapPx: number): number[][] {
  const groups: number[][] = [];
  let anchor = -Infinity;
  times.forEach((t, i) => {
    if (groups.length && (t - anchor) * pxPerMs < gapPx) groups.at(-1)!.push(i);
    else { groups.push([i]); anchor = t; }
  });
  return groups;
}
