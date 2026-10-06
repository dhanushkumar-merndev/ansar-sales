import { describe, expect, it } from "vitest";
import { botCommandsFor, buildHelp, buildTestReply, buildToday, commandOf, parseIncomingText, type BotSummary } from "@/lib/telegram-bot";

type Connected = Extract<BotSummary, { connected: true }>;
const base = { connected: true as const, name: "Asha", date: "2026-10-06" };
const APP = "https://crm.example.com";

describe("telegram bot", () => {
  it("reads private text messages only", () => {
    expect(parseIncomingText({ message: { text: " hi ", chat: { id: 5, type: "private" } } })).toEqual({ chatId: 5, text: "hi" });
    expect(parseIncomingText({ message: { text: "hi", chat: { id: 5, type: "group" } } })).toBeNull();
    expect(parseIncomingText({ message: { sticker: {}, chat: { id: 5, type: "private" } } })).toEqual({ chatId: 5, text: "" });
  });

  it("maps commands and keyboard buttons to actions", () => {
    expect(commandOf("/today")).toBe("today");
    expect(commandOf("📋 Today")).toBe("today");
    expect(commandOf("/today@StarGrowthBot")).toBe("today");
    expect(commandOf("🧪 Test")).toBe("test");
    expect(commandOf("/test")).toBe("test");
    expect(commandOf("Oki")).toBe("help");
    expect(commandOf("/start")).toBe("help");
  });

  it("offers Today to every role except client", () => {
    const sales = buildHelp({ ...base, role: "sales" }, APP);
    expect(sales.text).toContain("Hi Asha (Sales)");
    expect(sales.text).toContain("/today");
    expect(sales.text).toContain(`Open the CRM: ${APP}`);
    expect(sales.reply_markup).toMatchObject({ keyboard: [[{ text: "📋 Today" }, { text: "🧪 Test" }], [{ text: "❓ Help" }]], resize_keyboard: true });
    const client = buildHelp({ ...base, role: "client" }, null);
    expect(client.text).not.toContain("/today");
    expect(client.text).not.toContain("Open the CRM");
    expect(botCommandsFor("client").map((c) => c.command)).toEqual(["test", "help"]);
    expect(botCommandsFor("admin").map((c) => c.command)).toEqual(["today", "test", "help"]);
  });

  it("summarises tasks for sales, and adds the team for admins", () => {
    const s: Connected = {
      ...base, role: "admin", today: 1, overdue: 2,
      tasks: [
        { task: "Call back", lead_name: "Ravi", due_at: "2026-10-05T05:00:00Z", overdue: true },
        { task: "Send quote", lead_name: "Meena", due_at: "2026-10-06T08:30:00Z", overdue: false },
      ],
      team: { new_leads: 4, won: 1, overdue: 6 },
    };
    const r = buildToday(s, APP);
    expect(r.text).toContain("📋 Today — 6 Oct · Due 1 · Overdue 2");
    expect(r.text).toMatch(/• ⚠️ 5 Oct, 10:30 am — Ravi: Call back/);
    expect(r.text).toMatch(/• 2:00 pm — Meena: Send quote/);
    expect(r.text).toContain("…and 1 more");
    expect(r.text).toContain("🏢 Team today: New leads 4 · Won 1 · Overdue 6 ⚠️");
    expect(r.reply_markup).toEqual({ inline_keyboard: [[{ text: "Open follow-ups", url: `${APP}/follow-ups?view=overdue` }]] });
    expect(buildToday({ ...base, role: "sales", today: 0, overdue: 0, tasks: [] }, null).text).toContain("No follow-ups due today");
  });

  it("shows month totals for accounts and problem accounts for ads managers", () => {
    const acc = buildToday({ ...base, role: "account", finance: { month: "2026-10", expense_total: "25000.00", expense_count: 1, capital_total: 0 } }, APP);
    expect(acc.text).toContain("October 2026 so far");
    expect(acc.text).toContain("Expenses: ₹25,000 (1 entry)");
    const ads = buildToday({ ...base, role: "ads_manager", ads: { problem_count: 4, problem_names: ["A", "B", "C"] } }, null);
    expect(ads.text).toContain("Ad accounts needing attention: 4");
    expect(ads.text).toContain("…and 1 more");
    expect(ads.reply_markup).toBeUndefined();
    expect(buildTestReply({ ...base, role: "sales" }).text).toContain("✅ Test message");
  });
});
