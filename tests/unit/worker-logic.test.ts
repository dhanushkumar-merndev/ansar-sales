import { describe, expect, it } from "vitest";
import { buildNotification, buildNotificationMessage, buildReminderMessage, classifyTelegramResult, constantTimeEqual, formatAgo, replyMarkup, sanitizeError, type ClaimedNotification } from "../../supabase/functions/reminder-worker/logic";
import { parseSilenceCallback, withoutCallbackButtons } from "../../src/lib/telegram";

const item = {
  delivery_id: "d", lease_token: "t", chat_id: 1, lead_id: "abc", lead_name: "Acme", lead_phone: "+91 98765 43210",
  task: "Call back", due_at: "2026-10-05T09:00:00Z", attempts: 1,
};

describe("reminder message", () => {
  it("shows IST due time, task and an Open lead button", () => {
    const { text, buttons } = buildReminderMessage(item, "https://crm.example.com/");
    expect(text).toContain("Lead: Acme");
    expect(text).toContain("Task: Call back");
    expect(text).toMatch(/Due: 5 Oct 2026, 2:30 pm IST/i);
    expect(text).not.toContain("Open:");
    expect(buttons).toEqual([[{ text: "🔗 Open lead", url: "https://crm.example.com/leads/abc" }]]);
  });

  it("keeps a non-https link in the text (Telegram rejects such URL buttons)", () => {
    const m = buildReminderMessage(item, "http://localhost:3000");
    expect(m.text).toContain("Open: http://localhost:3000/leads/abc");
    expect(m.buttons).toEqual([]);
    expect(replyMarkup(m)).toBeUndefined();
  });
});

describe("telegram result classification", () => {
  it("sent", () => expect(classifyTelegramResult(200, { ok: true, result: { message_id: 9 } })).toEqual({ result: "sent", messageId: 9 }));
  it("rate limit honours retry_after", () =>
    expect(classifyTelegramResult(429, { ok: false, description: "Too Many Requests", parameters: { retry_after: 17 } })).toMatchObject({ result: "retry", retryAfterSeconds: 17, rateLimited: true }));
  it("blocked bot", () => expect(classifyTelegramResult(403, { ok: false, description: "Forbidden: bot was blocked by the user" }).result).toBe("blocked"));
  it("chat not found is treated as disconnected", () => expect(classifyTelegramResult(400, { ok: false, description: "Bad Request: chat not found" }).result).toBe("blocked"));
  it("server/network errors are temporary", () => {
    expect(classifyTelegramResult(502, null).result).toBe("retry");
    expect(classifyTelegramResult(0, null).result).toBe("retry");
  });
  it("other client errors fail permanently", () => expect(classifyTelegramResult(400, { ok: false, description: "Bad Request: message is too long" }).result).toBe("failed"));
});

describe("error sanitizing and secret comparison", () => {
  it("redacts tokens and urls", () => {
    const s = sanitizeError("fail https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ/sendMessage bot123456:abcdef");
    expect(s).not.toMatch(/ABCDEFGHIJ|abcdef/);
    expect(sanitizeError("x".repeat(500))).toHaveLength(300);
  });
  it("compares secrets", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("", "abc")).toBe(false);
  });
});

describe("buildNotificationMessage", () => {
  it("describes the monthly expense in INR with item, nos and payment mode", () => {
    const text = buildNotificationMessage({
      notification_id: "n", lease_token: "t", chat_id: 1, kind: "recurring_expense", attempts: 1,
      payload: { date: "2026-11-06", category: "software", amount: "1499.5", item: "ChatGPT", quantity: 2, payment_mode: "upi", description: null },
    }, "http://crm.local/");
    expect(text).toBe([
      "🔁 Monthly expense added", "Category: Software", "Item: ChatGPT × 2 nos", "Amount: ₹1,499.50", "Date: 6 Nov 2026", "Paid by: UPI",
      "Open: http://crm.local/finance",
    ].join("\n"));
  });
});

const note = (kind: ClaimedNotification["kind"], payload: Record<string, unknown>): ClaimedNotification =>
  ({ notification_id: "n", lease_token: "t", chat_id: 1, kind, payload, attempts: 1 });
const APP = "https://crm.example.com";
const FU = "0b7c4a9e-1f2d-4c3b-9a8e-123456789abc";

describe("role notifications", () => {
  it("overdue alert has Open lead and Silence buttons and says how late it is", () => {
    const m = buildNotification(note("overdue_nag", {
      lead_id: "L1", lead_name: "Acme", task: "Call", due_at: "2026-10-05T09:00:00Z", follow_up_id: FU, revision: 1, phone: "+91 90000 00000",
    }), APP, new Date("2026-10-05T10:15:00Z"));
    expect(m.text).toContain("⚠️ Follow-up overdue");
    expect(m.text).toContain("(1 h 15 min ago)");
    expect(m.buttons).toEqual([[{ text: "🔗 Open lead", url: `${APP}/leads/L1` }, { text: "🔕 Silence", callback_data: `s:${FU}` }]]);
  });

  it("links each kind to the right page", () => {
    const url = (k: ClaimedNotification["kind"], p: Record<string, unknown>) => (buildNotification(note(k, p), APP).buttons[0][0] as { url: string }).url;
    expect(url("lead_created", { lead_id: "L2", lead_name: "X", niche: "Retail", owner: "A", actor: "A" })).toBe(`${APP}/leads/L2`);
    expect(url("expense_added", { date: "2026-10-01", category: "rent", amount: 100, actor: "Acc" })).toBe(`${APP}/finance`);
    expect(url("library_file_added", { name: "Deck.pdf", folder: "Decks", folder_id: "F1", actor: "A" })).toBe(`${APP}/library/F1`);
    expect(url("digest_admin", { date: "2026-10-05", rows: [] })).toBe(`${APP}/dashboard`);
    expect(url("digest_sales", { date: "2026-10-05", today: 1, overdue: 2, tasks: [] })).toBe(`${APP}/follow-ups?view=overdue`);
  });

  it("formats won/lost, the team report and the finance summary", () => {
    expect(buildNotification(note("lead_closed", { lead_id: "L", lead_name: "Acme", owner: "A", actor: "B", status: "won" }), APP).text).toMatch(/^🏆 Lead won/);
    const report = buildNotification(note("digest_admin", { date: "2026-10-05", rows: [
      { name: "Sales A", active: 12, new_today: 2, done_today: 5, overdue: 1, won_today: 1, actions_today: 14, last_activity: "2026-10-05T13:15:00Z" },
    ] }), APP).text;
    expect(report).toContain("👤 Sales A");
    expect(report).toContain("Active 12 · New 2 · Done 5 · Overdue 1 ⚠️ · Won 1");
    const fin = buildNotification(note("digest_finance", {
      month: "2026-09", expense_total: "30500", expense_count: 3, capital_total: 0, categories: [{ category: "rent", total: "25000" }],
    }), APP).text;
    expect(fin).toContain("September 2026");
    expect(fin).toContain("Expenses: ₹30,500.00 (3 entries)");
    expect(fin).toContain("• Rent: ₹25,000.00");
  });

  it("names the company and opens the link inside it for the super admin", () => {
    const m = buildNotification(note("expense_added", {
      date: "2026-10-01", category: "rent", amount: 100, actor: "Acc", company: "Star Gardens", company_id: "C1",
    }), APP);
    expect(m.text.split("\n").slice(0, 2)).toEqual(["💸 Expense added", "🏢 Star Gardens"]);
    expect((m.buttons[0][0] as { url: string }).url).toBe(`${APP}/switch?company=C1&next=%2Ffinance`);
  });

  it("formatAgo", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    expect(formatAgo("2026-10-05T11:55:00Z", now)).toBe("5 min");
    expect(formatAgo("2026-10-05T10:00:00Z", now)).toBe("2 h");
    expect(formatAgo("2026-10-03T12:00:00Z", now)).toBe("2 days");
  });
});

describe("Silence callback parsing", () => {
  const update = (data: string, type = "private") => ({
    callback_query: {
      id: "cb1", data,
      message: { message_id: 7, chat: { id: 222, type }, reply_markup: { inline_keyboard: [[{ text: "🔗 Open lead", url: `${APP}/leads/L1` }, { text: "🔕 Silence", callback_data: `s:${FU}` }]] } },
    },
  });

  it("accepts a well-formed private-chat press", () => {
    const r = parseSilenceCallback(update(`s:${FU}`));
    expect(r).toMatchObject({ callbackId: "cb1", chatId: 222, messageId: 7, followUpId: FU });
    expect(withoutCallbackButtons(r!.keyboard)).toEqual({ inline_keyboard: [[{ text: "🔗 Open lead", url: `${APP}/leads/L1` }]] });
  });

  it("rejects malformed data and group chats", () => {
    expect(parseSilenceCallback(update("s:not-a-uuid"))).toBeNull();
    expect(parseSilenceCallback(update(`x:${FU}`))).toBeNull();
    expect(parseSilenceCallback(update(`s:${FU}`, "group"))).toBeNull();
    expect(parseSilenceCallback({ message: { text: "/start" } })).toBeNull();
  });
});
