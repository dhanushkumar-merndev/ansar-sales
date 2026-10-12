import { describe, expect, it } from "vitest";
import { buildNotification, type ClaimedNotification } from "../../supabase/functions/reminder-worker/logic";
import { NOTIFICATION_KINDS, notificationKindsFor } from "@/lib/notifications";

const n = (kind: ClaimedNotification["kind"], payload: Record<string, unknown>): ClaimedNotification =>
  ({ notification_id: "n", lease_token: "t", chat_id: 1, kind, payload, attempts: 1 });
const project = { project_id: "p1", project: "Mr. Hari Residence", code: "SG-2026-001", client: "Hari" };

describe("project Telegram messages", () => {
  it("late phase: deadline, days late, owner, and a link to the timeline", () => {
    const m = buildNotification(n("phase_overdue", { ...project, phase: "GFC drawings", deadline: "2026-10-05", late_days: 3, owner: "Diny" }), "https://crm.example.com");
    expect(m.text).toContain("🚨 Phase is late");
    expect(m.text).toContain("Project: Mr. Hari Residence (SG-2026-001) · Hari");
    expect(m.text).toMatch(/Deadline was: 5 Oct 2026 \(3 days late\)/);
    expect(m.text).toContain("Owner: Diny");
    expect(m.buttons[0][0]).toEqual({ text: "🔗 Open timeline", url: "https://crm.example.com/projects/p1?tab=timeline" });
  });

  it("payments show exact INR amounts and open the payments tab", () => {
    const m = buildNotification(n("payment_received", { ...project, amount: 234000.3, mode: "upi", reference: "UTR1", milestone: "Advance", paid_on: "2026-10-06", actor: "Prema" }), "https://crm.example.com");
    expect(m.text).toContain("Amount: ₹2,34,000.30");
    expect(m.text).toContain("Mode: UPI · UTR1");
    expect(m.buttons[0][0]).toMatchObject({ url: "https://crm.example.com/projects/p1?tab=payments" });
  });

  it("site visit reminder for a lead (no project yet) opens site visits", () => {
    const m = buildNotification(n("site_visit_reminder", { lead: "Karthik", purpose: "Measure", at: "2026-10-07T05:00:00Z", phone: "+91 98765 43210" }), "https://crm.example.com");
    expect(m.text).toContain("Lead: Karthik");
    expect(m.text).toMatch(/When: 7 Oct 2026, 10:30 am IST/i);
    expect(m.buttons[0][0]).toMatchObject({ url: "https://crm.example.com/site-visits" });
  });

  it("names the company for the super admin and opens it via /switch", () => {
    const m = buildNotification(n("lead_handed_off", { lead_id: "l1", lead_name: "Hari", actor: "Dhanush", company: "Star Gardens", company_id: "c1" }), "https://crm.example.com");
    expect(m.text.split("\n")[1]).toBe("🏢 Star Gardens");
    expect(m.buttons[0][0]).toMatchObject({ url: `https://crm.example.com/switch?company=c1&next=${encodeURIComponent("/leads/l1")}` });
  });

  it("every project kind has a message", () => {
    for (const k of ["project_assigned", "phase_assigned", "phase_due_soon", "phase_submitted", "phase_changes", "project_at_risk", "payment_due",
      "payment_overdue", "boq_status", "snag_assigned", "project_completed"] as const) {
      const m = buildNotification(n(k, { ...project, phase: "Layout", deadline: "2026-10-05", end_date: "2026-10-31", last_deadline: "2026-11-05",
        balance: 1000, due_on: "2026-10-01", days_overdue: 9, milestone: "Advance", label: "R2", status: "sent", snag: "Fix drip", role: "landscape_designer", actor: "Raj" }), null);
      expect(m.text.length, k).toBeGreaterThan(10);
      expect(m.text).not.toContain("undefined");
    }
  });
});

describe("notification settings list", () => {
  it("shows project alerts only in companies with the module, by role", () => {
    const designer = notificationKindsFor(["landscape_designer"], ["projects"]).map((k) => k.kind);
    expect(designer).toEqual(expect.arrayContaining(["phase_overdue", "phase_changes"]));
    expect(designer).not.toContain("payment_received");
    expect(notificationKindsFor(["sales", "account"]).map((k) => k.kind)).not.toContain("payment_due");
    expect(notificationKindsFor(["sales", "account"], ["projects"]).map((k) => k.kind)).toContain("payment_due");
    expect(new Set(NOTIFICATION_KINDS.map((k) => k.kind)).size).toBe(NOTIFICATION_KINDS.length);
  });
});
