import { describe, expect, it } from "vitest";
import { notificationDay, notificationTarget, showNotification } from "@/lib/app-notifications";
import { NOTIFICATION_KINDS } from "@/lib/notifications";

// The bell shows the same words as Telegram (the worker's describeNotification), as icon + title + details + link.

const payload = {
  lead_id: "l1", lead_name: "Hari", project_id: "p1", project: "Hari Residence", code: "SG-2026-001", client: "Hari", phase: "GFC drawings",
  deadline: "2026-10-09", late_days: 2, actor: "Raj", owner: "Diny", milestone: "Advance", amount: 1000, balance: 500, due_on: "2026-10-01",
  days_overdue: 9, mode: "upi", paid_on: "2026-10-07", file: "Layout.pdf", file_id: "f1", version_no: 2, approved: true, status: "won",
  name: "Doc", folder: "Decks", folder_id: "d1", category: "rent", date: "2026-10-07", contributor: "Owner", task: "Call", due_at: "2026-10-07T10:00:00Z",
  rows: [], tasks: [], today: 0, overdue: 0, month: "2026-09", expense_total: 0, expense_count: 0, capital_total: 0, categories: [],
  snag: "Fix tiles", label: "R2", role: "landscape_designer", purpose: "Measure", at: "2026-10-08T05:00:00Z", reason: "past_end", end_date: "2026-10-01",
  account_name: "Ads", ads_client_id: "a1", follow_up_id: "u1", revision: 1, niche: "Villa", note: "Interested",
};

describe("bell items", () => {
  it("has a title and a link for every kind people can switch on", () => {
    for (const { kind } of NOTIFICATION_KINDS) {
      const s = showNotification({ kind, payload });
      expect(s.title, kind).toBeTruthy();
      expect(s.title, kind).not.toMatch(/^\p{Extended_Pictographic}/u); // the emoji moved to the icon
      expect(s.href.startsWith("/"), kind).toBe(true);
    }
  });

  it("splits the emoji, and shows the company to the super admin", () => {
    const s = showNotification({ kind: "phase_submitted", payload: { ...payload, company: "Star Gardens", company_id: "c1" } });
    expect([s.icon, s.title, s.company]).toEqual(["📤", "Phase sent for review", "Star Gardens"]);
    expect(s.details[0]).toBe("Project: Hari Residence (SG-2026-001) · Hari");
    expect(s.href).toBe(`/switch?company=c1&next=${encodeURIComponent("/projects/p1?tab=timeline")}`);
  });

  it("switches company only for a link into another one", () => {
    const href = `/switch?company=c1&next=${encodeURIComponent("/projects/p1?tab=timeline")}`;
    expect(notificationTarget(href, "c2")).toEqual({ path: "/projects/p1?tab=timeline", switchTo: "c1" });
    expect(notificationTarget(href, "c1")).toEqual({ path: "/projects/p1?tab=timeline", switchTo: null });
    expect(notificationTarget("/leads/l1", "c1")).toEqual({ path: "/leads/l1", switchTo: null });
    expect(notificationTarget("/switch?company=c1&next=//evil.example", "c2").path).toBe("/dashboard");
  });

  it("copes with a kind it doesn't know (a newer database)", () => {
    const s = showNotification({ kind: "something_new", payload: {} });
    expect([s.icon, s.title, s.href]).toEqual(["🔔", "something new", "/dashboard"]);
  });

  it("groups by IST day", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    expect(notificationDay("2026-10-07T00:30:00Z", now)).toBe("Today");
    expect(notificationDay("2026-10-06T19:00:00Z", now)).toBe("Today"); // 00:30 IST on the 7th
    expect(notificationDay("2026-10-06T18:00:00Z", now)).toBe("Yesterday"); // 23:30 IST on the 6th
    expect(notificationDay("2026-10-01T06:00:00Z", now)).toMatch(/^Thu, 1 Oct/);
  });
});
