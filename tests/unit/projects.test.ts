import { describe, expect, it } from "vitest";
import { allocatePayment, daysBetween, defaultScheduleRows, phaseLateDays, scheduleToMilestones, spreadTemplate, STAR_GARDENS_TEMPLATE, scheduleExcess, scheduleExcessMessage, sumAmounts, countMonths, groupYears, monthRange } from "@/lib/projects";
import { projectCreateSchema } from "@/lib/project-validation";

describe("Star Gardens timeline template", () => {
  it("lays every phase back to back inside the project dates", () => {
    const phases = spreadTemplate("2026-10-01", "2026-11-14");
    expect(phases).toHaveLength(STAR_GARDENS_TEMPLATE.length);
    expect(phases[0].planned_start).toBe("2026-10-01");
    expect(phases.at(-1)!.deadline).toBe("2026-11-14");
    for (let i = 0; i < phases.length; i++) {
      expect(phases[i].deadline >= phases[i].planned_start).toBe(true);
      if (i > 0) expect(daysBetween(phases[i - 1].deadline, phases[i].planned_start)).toBe(1);
    }
    expect(phases.find((p) => p.name === "GFC drawings")!.items).toContain("Planting plan");
  });

  it("still gives every phase a day when the project is very short", () => {
    const phases = spreadTemplate("2026-10-01", "2026-10-04");
    expect(phases.every((p) => p.deadline >= p.planned_start)).toBe(true);
    expect(phases.every((p) => p.planned_start >= "2026-10-01" && p.deadline <= "2026-10-04")).toBe(true);
    expect(phases.at(-1)!.deadline).toBe("2026-10-04");
  });

  it("is accepted by the create-project schema", () => {
    const r = projectCreateSchema.safeParse({
      name: "Mr. Hari Residence", clientName: "Hari", startDate: "2026-10-01", endDate: "2026-10-31",
      contractValue: "780000", phases: spreadTemplate("2026-10-01", "2026-10-31"),
    });
    expect(r.success).toBe(true);
    expect(projectCreateSchema.safeParse({ name: "x", clientName: "y", startDate: "2026-10-05", endDate: "2026-10-01", phases: [] }).success).toBe(false);
  });
});

describe("phase lateness", () => {
  it("counts open phases against today and submitted ones against the submission day", () => {
    expect(phaseLateDays({ status: "in_progress", deadline: "2026-10-05", submitted_on: null }, "2026-10-08")).toBe(3);
    expect(phaseLateDays({ status: "in_progress", deadline: "2026-10-05", submitted_on: null }, "2026-10-05")).toBe(0);
    expect(phaseLateDays({ status: "done", deadline: "2026-10-05", submitted_on: "2026-10-08" }, "2026-10-20")).toBe(3);
    expect(phaseLateDays({ status: "in_review", deadline: "2026-10-05", submitted_on: "2026-10-04" }, "2026-10-20")).toBe(0);
    expect(phaseLateDays({ status: "skipped", deadline: "2026-10-05", submitted_on: null }, "2026-10-20")).toBe(0);
  });
});

describe("editable payment schedule", () => {
  const phases = spreadTemplate("2026-10-01", "2026-11-30");
  it("splits the value exactly when the parts add up to 100%", () => {
    const ms = scheduleToMilestones(defaultScheduleRows("2026-10-01"), phases, 780000.3, "2026-10-01");
    expect(ms.map((m) => m.amount)).toEqual(["234000.09", "156000.06", "234000.09", "156000.06"]);
    expect(ms.reduce((t, m) => t + Number(m.amount), 0)).toBeCloseTo(780000.3, 2);
    expect(ms[1]).toMatchObject({ due_trigger: "phase", phase_index: 2 });
    expect(ms[0]).toMatchObject({ due_trigger: "date", due_date: "2026-10-01" });
  });

  it("keeps each part on its own when the admin's parts don't add up to 100%", () => {
    const rows = [{ label: " Token ", percent: "10", due_trigger: "date" as const, due_date: "2026-10-05", phase_name: "" },
      { label: "Rest", percent: "50", due_trigger: "phase" as const, due_date: "", phase_name: "Not a phase" }];
    const ms = scheduleToMilestones(rows, phases, 100000, "2026-10-01");
    expect(ms).toEqual([
      { label: "Token", percent: 10, amount: "10000.00", due_trigger: "date", due_date: "2026-10-05" },
      // Its phase isn't in the timeline: due on the start date instead.
      { label: "Rest", percent: 50, amount: "50000.00", due_trigger: "date", due_date: "2026-10-01" },
    ]);
  });
});

describe("payment preview", () => {
  const ms = [{ id: "a", label: "Advance", balance: 0 }, { id: "b", label: "Design", balance: 156000.06 }, { id: "c", label: "Final", balance: 390000 }];
  it("fills the oldest open part first and keeps the rest due", () => {
    expect(allocatePayment(ms, 200000)).toEqual({
      parts: [{ id: "b", label: "Design", applied: 156000.06, clears: true }, { id: "c", label: "Final", applied: 43999.94, clears: false }],
      ahead: 0,
    });
  });
  it("shows money beyond the whole schedule as ahead", () => {
    expect(allocatePayment(ms, 600000).ahead).toBe(53999.94);
  });
});


describe("the schedule can't ask for more than the contract value", () => {
  it("compares exactly to the paisa", () => {
    expect(sumAmounts(["0.10", 0.2, "1292400.00"])).toBe(1292400.3);
    expect(scheduleExcess("1292400.30", sumAmounts(["0.10", 0.2, "1292400.00"]))).toBe(0); // 0.1 + 0.2 is not "over"
    expect(scheduleExcess(2580000, 4308600)).toBe(1728600);
    expect(scheduleExcess(2580000, 2580000.01)).toBe(0.01);
    expect(scheduleExcess(2580000, 1000000)).toBe(0); // less is fine while the schedule is being built
    expect(scheduleExcess(null, 4308600)).toBe(0); // no contract value yet: nothing to compare
    expect(scheduleExcess("", 4308600)).toBe(0);
  });

  it("says why and what to do", () => {
    const m = scheduleExcessMessage(4308600, 2580000);
    expect(m).toContain("₹43,08,600.00");
    expect(m).toContain("₹17,28,600.00 more");
    expect(m).toContain("₹25,80,000.00");
    expect(m).toMatch(/raise the contract value/);
  });
});

describe("projects as year → month folders", () => {
  it("gives each month folder its start-date range, December rolling into the next year", () => {
    expect(monthRange(2026, 10)).toEqual({ from: "2026-10-01", to: "2026-11-01" });
    expect(monthRange(2026, 12)).toEqual({ from: "2026-12-01", to: "2027-01-01" });
    expect(monthRange(2027, 1)).toEqual({ from: "2027-01-01", to: "2027-02-01" });
  });

  it("puts the newest year first with its months January → December, adding up the counts", () => {
    const m = (year: number, month: number, total: number, late = 0) => ({ year, month, total, late, active: total, colors: [] });
    const years = groupYears([m(2026, 10, 3, 1), m(2026, 2, 1), m(2025, 12, 2, 2), m(2026, 7, 4)]);
    expect(years.map((y) => [y.year, y.total, y.late, y.months.map((x) => x.month)])).toEqual([[2026, 8, 1, [2, 7, 10]], [2025, 2, 2, [12]]]);
    expect(groupYears([])).toEqual([]);
  });

  it("counts months from bare rows while the database is behind", () => {
    const rows = [
      { start_date: "2026-10-07", status: "active", color: "sky" }, { start_date: "2026-10-31", status: "on_hold", color: "pink" },
      { start_date: "2026-09-01", status: "active", color: "amber" },
    ];
    expect(countMonths(rows).map((x) => [x.year, x.month, x.total, x.active, x.colors])).toEqual([[2026, 10, 2, 1, ["sky", "pink"]], [2026, 9, 1, 1, ["amber"]]]);
  });
});
