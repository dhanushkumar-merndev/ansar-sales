import { describe, expect, it } from "vitest";
import { buildDashboard, parseIncomingText, type BotSummary } from "@/lib/telegram-bot";

type Connected = Extract<BotSummary, { connected: true }>;
const base = { connected: true as const, name: "Asha", date: "2026-10-06" };
const APP = "https://crm.example.com";

describe("telegram bot", () => {
  it("reads private messages only", () => {
    expect(parseIncomingText({ message: { text: " hi ", chat: { id: 5, type: "private" } } })).toEqual({ chatId: 5, text: "hi" });
    expect(parseIncomingText({ message: { text: "hi", chat: { id: 5, type: "group" } } })).toBeNull();
    expect(parseIncomingText({ message: { sticker: {}, chat: { id: 5, type: "private" } } })).toEqual({ chatId: 5, text: "" });
  });

  it("answers with the dashboard only, and clears the old keyboard", () => {
    const r = buildDashboard({ ...base, role: "sales", today: 0, overdue: 0, tasks: [] }, APP);
    expect(r.reply_markup).toEqual({ remove_keyboard: true });
    expect(r.text).toContain("👋 Hi Asha");
    expect(r.text).toContain("No follow-ups due today");
    expect(r.text).not.toMatch(/Test|Help/);
    expect(r.text).toContain(`🔗 ${APP}/follow-ups`);
  });

  it("lists tasks, and the team's day for admins", () => {
    const s: Connected = {
      ...base, role: "admin", today: 1, overdue: 2,
      tasks: [
        { task: "Call back", lead_name: "Ravi", due_at: "2026-10-05T05:00:00Z", overdue: true },
        { task: "Send quote", lead_name: "Meena", due_at: "2026-10-06T08:30:00Z", overdue: false },
      ],
      team: { new_leads: 4, won: 1, overdue: 6 },
    };
    const r = buildDashboard(s, APP);
    expect(r.text).toContain("📋 6 Oct · Due today 1 · Overdue 2");
    expect(r.text).toMatch(/• ⚠️ 5 Oct, 10:30 am — Ravi: Call back/);
    expect(r.text).toMatch(/• 2:00 pm — Meena: Send quote/);
    expect(r.text).toContain("…and 1 more");
    expect(r.text).toContain("🏢 Team today: New leads 4 · Won 1 · Overdue 6 ⚠️");
    expect(r.text).toContain(`🔗 ${APP}/dashboard`);
  });

  it("shows month totals for accounts, ad problems for ads managers, a greeting for clients", () => {
    const acc = buildDashboard({ ...base, role: "account", finance: { month: "2026-10", expense_total: "25000.00", expense_count: 1, capital_total: 0 } }, null);
    expect(acc.text).toContain("October 2026 so far");
    expect(acc.text).toContain("Expenses: ₹25,000 (1 entry)");
    expect(acc.text).not.toContain("🔗");
    const ads = buildDashboard({ ...base, role: "ads_manager", ads: { problem_count: 4, problem_names: ["A", "B", "C"] } }, null);
    expect(ads.text).toContain("Ad accounts needing attention: 4");
    expect(ads.text).toContain("…and 1 more");
    expect(buildDashboard({ ...base, role: "client" }, null).text).toBe("👋 Hi Asha\nYour CRM alerts arrive here.");
  });
});
