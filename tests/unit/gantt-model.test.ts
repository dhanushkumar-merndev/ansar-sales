import { describe, expect, it } from "vitest";
import { buildTrack, clusterChanges, DAY, duration, HOUR, IST, ts } from "@/components/projects/timeline/gantt-model";
import type { Phase, PhaseEvent } from "@/lib/projects";

const phase = (o: Partial<Phase> = {}) => ({
  id: "ph", name: "First cut", category: "Design", status: "changes_requested", planned_start: "2026-10-07", deadline: "2026-10-09",
  actual_start: "2026-10-07", submitted_on: null, ...o,
}) as Phase;
// The real history from the live project: in progress 16:00, in review 16:03, changes requested 16:11 (IST).
const events: PhaseEvent[] = [
  { phase_id: "ph", at: "2026-10-07T10:30:16Z", from: "not_started", to: "in_progress", by: "Diny" },
  { phase_id: "ph", at: "2026-10-07T10:33:48Z", from: "in_progress", to: "in_review", by: "Diny" },
  { phase_id: "ph", at: "2026-10-07T10:41:48Z", from: "in_review", to: "changes_requested", by: "Raj" },
];
const wallOf = (iso: string) => Date.parse(iso) + IST;
const NOW = wallOf("2026-10-07T12:00:00Z");

describe("status track", () => {
  it("has one stretch per status and a change for each event; the last open status runs to now", () => {
    const t = buildTrack(phase(), events, NOW);
    expect(t.segments.map((s) => [s.status, s.from, s.to, s.open, s.by])).toEqual([
      ["in_progress", wallOf(events[0].at), wallOf(events[1].at), false, "Diny"],
      ["in_review", wallOf(events[1].at), wallOf(events[2].at), false, "Diny"],
      ["changes_requested", wallOf(events[2].at), NOW, true, "Raj"],
    ]);
    expect(t.marks.map((m) => [m.status, m.was, m.by])).toEqual([["in_progress", "not_started", "Diny"], ["in_review", "in_progress", "Diny"], ["changes_requested", "in_review", "Raj"]]);
    expect(t.end).toBe(NOW);
  });

  it("ends at the change when the phase is done (no stretch after done)", () => {
    const done: PhaseEvent[] = [...events, { phase_id: "ph", at: "2026-10-07T11:00:00Z", from: "changes_requested", to: "done", by: "Raj" }];
    const t = buildTrack(phase({ status: "done" }), done, NOW);
    expect(t.segments.at(-1)).toMatchObject({ status: "changes_requested", to: wallOf("2026-10-07T11:00:00Z"), open: false });
    expect(t.marks.at(-1)?.status).toBe("done");
    expect(t.end).toBe(wallOf("2026-10-07T11:00:00Z"));
  });

  it("without a history, splits a same-day start and submit so both statuses show", () => {
    const t = buildTrack(phase({ status: "in_review", submitted_on: "2026-10-07" }), [], NOW);
    expect(t.segments.map((s) => s.status)).toEqual(["in_progress", "in_review"]);
    expect(t.segments[0].to).toBeGreaterThan(t.segments[0].from);
    expect(t.segments[1].to).toBeGreaterThan(t.segments[1].from);
    expect(t.marks.map((m) => m.status)).toEqual(["in_progress", "in_review"]);
  });

  it("draws nothing for a phase that never started", () => {
    expect(buildTrack(phase({ status: "not_started", actual_start: null }), [], NOW)).toMatchObject({ segments: [], marks: [], end: null });
  });
});

describe("combining close changes by zoom", () => {
  const times = events.map((e) => wallOf(e.at));
  it("combines the three changes when 11 minutes are a few pixels (whole-project zoom)", () => {
    const pxPerMs = 40 / DAY; // a day is 40 px
    expect(clusterChanges(times, pxPerMs, 10)).toEqual([[0, 1, 2]]);
  });
  it("shows them apart when zoomed in to hours", () => {
    const pxPerMs = 600 / (3 * HOUR); // 3 hours across 600 px: 3.5 min ≈ 12 px
    expect(clusterChanges(times, pxPerMs, 10)).toEqual([[0], [1], [2]]);
  });
  it("anchors each group at its first change, so a long run never becomes one wide block", () => {
    const run = Array.from({ length: 6 }, (_, i) => i * 5 * 60_000); // every 5 minutes
    const pxPerMs = 1 / 60_000; // 1 px per minute
    expect(clusterChanges(run, pxPerMs, 10)).toEqual([[0, 1], [2, 3], [4, 5]]);
  });
  it("handles none or one change", () => {
    expect(clusterChanges([], 1, 10)).toEqual([]);
    expect(clusterChanges([5], 1, 10)).toEqual([[0]]);
  });
});

describe("durations", () => {
  it("reads naturally", () => {
    expect(duration(30_000)).toBe("1 min");
    expect(duration(8 * 60_000)).toBe("8 min");
    expect(duration(3 * HOUR + 20 * 60_000)).toBe("3 h 20 min");
    expect(duration(2 * DAY + 4 * HOUR)).toBe("2 days 4 h");
    expect(duration(DAY)).toBe("1 day");
  });
  it("uses IST wall-clock dates", () => {
    expect(ts("2026-10-07")).toBe(Date.parse("2026-10-07T00:00:00Z"));
  });
});
