import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildLinkUrl, classifyWhatsAppResult, extractLinkCode, messageBody, nudgeMessage, parseAction, parseWebhook, toWhatsApp, verifySignature,
} from "../../supabase/functions/_shared/whatsapp";
import { buildNotification, buildReminderMessage, type ClaimedNotification } from "../../supabase/functions/reminder-worker/logic";

const APP = "https://crm.example.com";

describe("link codes", () => {
  it("finds the code in the typed message, in any case, and ignores ordinary words", () => {
    expect(extractLinkCode("Link my CRM: 7KQ2PX")).toBe("7KQ2PX");
    expect(extractLinkCode("link my crm 7kq2px please")).toBe("7KQ2PX");
    expect(extractLinkCode("THANKS")).toBeNull(); // letters only
    expect(extractLinkCode("123456")).toBeNull(); // digits only
    expect(extractLinkCode("AB01CD")).toBeNull(); // 0 and 1 are never used
    expect(extractLinkCode(null)).toBeNull();
  });

  it("builds a wa.me link with the code typed in", () => {
    expect(buildLinkUrl("+91 98765 43210", "7KQ2PX")).toBe("https://wa.me/919876543210?text=Link%20my%20CRM%3A%207KQ2PX");
  });
});

describe("webhook", () => {
  const payload = (value: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "1", changes: [{ field: "messages", value: { metadata: { phone_number_id: "111" }, ...value } }] }],
  });

  it("reads texts, button taps and failed delivery reports for our number only", () => {
    const body = payload({
      messages: [
        { from: "919800011111", type: "text", text: { body: "hi" } },
        { from: "919800011111", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "keep", title: "Keep alerts on" } } },
        { from: "not-a-number", type: "text", text: { body: "x" } },
      ],
      statuses: [{ id: "wamid.1", status: "failed", errors: [{ code: 131047 }] }, { id: "wamid.2", status: "read" }],
    });
    const r = parseWebhook(body, "111");
    expect(r.messages).toEqual([
      { from: "919800011111", text: "hi", buttonId: null },
      { from: "919800011111", text: null, buttonId: "keep" },
    ]);
    expect(r.statuses).toEqual([{ id: "wamid.1", status: "failed", errorCode: 131047 }, { id: "wamid.2", status: "read", errorCode: null }]);
    expect(parseWebhook(body, "999")).toEqual({ messages: [], statuses: [] });
    expect(parseWebhook({ object: "page", entry: [] })).toEqual({ messages: [], statuses: [] });
  });

  it("understands the buttons", () => {
    const id = "6d6bdecc-bd98-4ac9-ad02-5200f91be90e";
    expect(parseAction({ from: "1", text: null, buttonId: "keep" })).toEqual({ type: "keep" });
    expect(parseAction({ from: "1", text: null, buttonId: "summary" })).toEqual({ type: "summary" });
    expect(parseAction({ from: "1", text: null, buttonId: `silence:${id}` })).toEqual({ type: "silence", followUpId: id });
    expect(parseAction({ from: "1", text: null, buttonId: "silence:nope" })).toEqual({ type: "other" });
    expect(parseAction({ from: "1", text: "today", buttonId: null })).toEqual({ type: "other" });
  });

  it("accepts only Meta's signature made with the app secret", async () => {
    const raw = JSON.stringify({ hello: "world" });
    const sig = `sha256=${createHmac("sha256", "s3cret").update(raw).digest("hex")}`;
    expect(await verifySignature(raw, sig, "s3cret")).toBe(true);
    expect(await verifySignature(raw, sig, "other")).toBe(false);
    expect(await verifySignature(`${raw} `, sig, "s3cret")).toBe(false);
    expect(await verifySignature(raw, null, "s3cret")).toBe(false);
    expect(await verifySignature(raw, sig, "")).toBe(false);
  });
});

describe("messages", () => {
  it("sends alerts with an Open in CRM link button", () => {
    const m = toWhatsApp(buildReminderMessage({
      delivery_id: "d", lease_token: "t", chat_id: null, channel: "whatsapp", wa_id: "919800011111", lead_id: "L1",
      lead_name: "Asha", lead_phone: "+91 98000 11111", task: "Call back", due_at: "2026-10-31T09:30:00Z", attempts: 1,
    }, APP));
    expect(m).toMatchObject({ kind: "link", label: "Open lead", url: `${APP}/leads/L1` });
    expect(m.text).toContain("Lead: Asha");
    const body = messageBody("919800011111", m);
    expect(body).toMatchObject({ to: "919800011111", type: "interactive", interactive: { type: "cta_url", action: { name: "cta_url", parameters: { display_text: "Open lead" } } } });
  });

  it("gives overdue alerts Silence and Keep buttons, with the link in the text", () => {
    const n: ClaimedNotification = {
      notification_id: "n", lease_token: "t", chat_id: null, attempts: 1, kind: "overdue_nag",
      payload: { lead_id: "L1", lead_name: "Asha", task: "Call", due_at: "2026-10-31T09:30:00Z", follow_up_id: "F1" },
    };
    const m = toWhatsApp(buildNotification(n, APP));
    expect(m.kind).toBe("buttons");
    if (m.kind !== "buttons") return;
    expect(m.buttons.map((b) => b.id)).toEqual(["silence:F1", "keep"]);
    expect(m.text).toContain(`${APP}/leads/L1`);
  });

  it("falls back to plain text without an https link (local development)", () => {
    const m = toWhatsApp(buildReminderMessage({
      delivery_id: "d", lease_token: "t", chat_id: null, lead_id: "L1", lead_name: "Asha", lead_phone: null, task: "Call", due_at: "2026-10-31T09:30:00Z", attempts: 1,
    }, "http://localhost:3000"));
    expect(m.kind).toBe("text");
    expect(messageBody("1", m)).toMatchObject({ type: "text", text: { preview_url: false } });
  });

  it("keeps within WhatsApp's limits", () => {
    const m = toWhatsApp({ text: "x".repeat(5000), buttons: [[{ text: "🔗 A very long button label indeed", url: `${APP}/x` }]] });
    expect(m.kind).toBe("link");
    if (m.kind !== "link") return;
    expect(m.text.length).toBe(1024);
    expect(m.label.length).toBeLessThanOrEqual(20);
    const nudge = messageBody("1", nudgeMessage("Asha")) as { interactive: { action: { buttons: { reply: { title: string } }[] } } };
    expect(nudge.interactive.action.buttons.every((b) => b.reply.title.length <= 20)).toBe(true);
  });
});

describe("send results", () => {
  it("maps Cloud API answers to what the worker records", () => {
    expect(classifyWhatsAppResult(200, { messages: [{ id: "wamid.X" }] })).toEqual({ result: "sent", externalId: "wamid.X" });
    expect(classifyWhatsAppResult(400, { error: { code: 131047, message: "Re-engagement message" } })).toMatchObject({ result: "hold" });
    expect(classifyWhatsAppResult(429, { error: { code: 130429, message: "rate" } })).toMatchObject({ result: "retry", rateLimited: true });
    expect(classifyWhatsAppResult(400, { error: { code: 131026, message: "undeliverable" } })).toEqual({ result: "blocked", error: "whatsapp_undeliverable" });
    expect(classifyWhatsAppResult(401, { error: { code: 190, message: "token expired" } })).toEqual({ result: "failed", error: "whatsapp_token_invalid" });
    expect(classifyWhatsAppResult(0, null)).toMatchObject({ result: "retry", rateLimited: false });
    expect(classifyWhatsAppResult(503, null)).toMatchObject({ result: "retry" });
    const other = classifyWhatsAppResult(400, { error: { code: 100, message: "Invalid parameter for +919876543210 at https://x.y/z" } });
    expect(other.result).toBe("failed");
    expect("error" in other && other.error).not.toMatch(/919876543210|https:/);
  });
});
