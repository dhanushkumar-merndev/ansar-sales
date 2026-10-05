import { describe, expect, it } from "vitest";
import { buildReminderMessage, classifyTelegramResult, constantTimeEqual, sanitizeError } from "../../supabase/functions/reminder-worker/logic";

const item = {
  delivery_id: "d", lease_token: "t", chat_id: 1, lead_id: "abc", lead_name: "Acme", lead_phone: "+91 98765 43210",
  task: "Call back", due_at: "2026-10-05T09:00:00Z", attempts: 1,
};

describe("reminder message", () => {
  it("shows IST due time, task and an authenticated CRM link", () => {
    const text = buildReminderMessage(item, "https://crm.example.com/");
    expect(text).toContain("Lead: Acme");
    expect(text).toContain("Task: Call back");
    expect(text).toMatch(/Due: 5 Oct 2026, 2:30 pm IST/i);
    expect(text).toContain("Open: https://crm.example.com/leads/abc");
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
