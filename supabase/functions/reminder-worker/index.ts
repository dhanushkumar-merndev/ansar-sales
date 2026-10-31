// Reminder and notification delivery worker. Invoked every minute by Supabase Cron (pg_net) only
// when something is due. Authenticated with a dedicated secret header.
//
// Each alert goes to the person's active channel, picked by the database at claim time: Telegram, or
// WhatsApp (only while its free 24-hour window is open; otherwise the database holds the alert).
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildNotification, buildReminderMessage, classifyTelegramResult, constantTimeEqual, replyMarkup, type ClaimedNotification, type ClaimedReminder, type DeliveryOutcome, type TelegramMessage } from "./logic.ts";
import { classifyWhatsAppResult, GRAPH_VERSION, messageBody, nudgeMessage, templateBody, toWhatsApp, type WaMessage, type WaOutcome } from "../_shared/whatsapp.ts";

const BATCH_SIZE = 25;
const LEASE_SECONDS = 120;
const MAX_RUNTIME_MS = 20_000;
const SEND_GAP_MS = 50; // stays well below Telegram's ~30 msg/s bot limit and WhatsApp's 80 msg/s

function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
  return keys.default ?? Object.values(keys)[0] ?? "";
}

async function sendTelegram(token: string, chatId: number, message: TelegramMessage): Promise<DeliveryOutcome> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message.text, reply_markup: replyMarkup(message), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => null);
    return classifyTelegramResult(res.status, body);
  } catch {
    return classifyTelegramResult(0, null);
  }
}

type WaConfig = { token: string; phoneNumberId: string } | null;

async function postWhatsApp(wa: WaConfig, body: unknown): Promise<WaOutcome> {
  if (!wa) return { result: "failed", error: "whatsapp_not_configured" };
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${wa.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${wa.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return classifyWhatsAppResult(res.status, await res.json().catch(() => null));
  } catch {
    return classifyWhatsAppResult(0, null);
  }
}

const sendWhatsApp = (wa: WaConfig, to: string, m: WaMessage) => postWhatsApp(wa, messageBody(to, m));

/** One channel-neutral result for the finish RPCs. */
type Outcome = DeliveryOutcome | WaOutcome;
const rateLimit = (o: Outcome) => (o.result === "retry" && o.rateLimited ? o.retryAfterSeconds ?? 30 : null);

async function deliver(
  item: { channel?: string | null; chat_id: number | null; wa_id?: string | null },
  message: TelegramMessage,
  botToken: string,
  wa: WaConfig,
): Promise<Outcome> {
  if (item.channel === "whatsapp") {
    if (!item.wa_id) return { result: "failed", error: "whatsapp_not_connected" };
    return sendWhatsApp(wa, item.wa_id, toWhatsApp(message));
  }
  if (!botToken) return { result: "failed", error: "telegram_not_configured" };
  if (item.chat_id === null) return { result: "failed", error: "telegram_not_connected" };
  return sendTelegram(botToken, item.chat_id, message);
}

const finishArgs = (o: Outcome) => ({
  p_result: o.result,
  p_error: o.result === "sent" ? undefined : o.error,
  p_retry_after_seconds: o.result === "retry" ? o.retryAfterSeconds ?? undefined : undefined,
  p_external_id: o.result === "sent" && "externalId" in o ? o.externalId ?? undefined : undefined,
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = Deno.env.get("REMINDER_WORKER_SECRET") ?? "";
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  const waToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
  const waNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
  const wa: WaConfig = waToken && waNumberId ? { token: waToken, phoneNumberId: waNumberId } : null;
  // Optional, paid: a utility template that asks people whose window closed to tap and get their alerts.
  const reopenTemplate = Deno.env.get("WHATSAPP_REOPEN_TEMPLATE") ?? "";
  const templateLang = Deno.env.get("WHATSAPP_TEMPLATE_LANGUAGE") ?? "en";
  if (!secret || (!botToken && !wa)) return Response.json({ error: "worker not configured" }, { status: 500 });
  if (!constantTimeEqual(req.headers.get("x-worker-secret") ?? "", secret)) return new Response("Unauthorized", { status: 401 });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const appUrl = Deno.env.get("APP_URL") ?? null;
  const started = Date.now();
  const counts = { sent: 0, retry: 0, failed: 0, blocked: 0, hold: 0, lease_lost: 0 };

  while (Date.now() - started < MAX_RUNTIME_MS) {
    const { data, error } = await supabase.rpc("claim_due_reminders", { p_limit: BATCH_SIZE, p_lease_seconds: LEASE_SECONDS });
    if (error) {
      console.error("claim failed", error.code);
      return Response.json({ error: "claim failed", counts }, { status: 500 });
    }
    const batch = (data ?? []) as ClaimedReminder[];
    if (batch.length === 0) break;

    let rateLimitedFor: number | null = null;
    for (const item of batch) {
      // After a rate limit, put the rest of the batch back instead of hammering the API.
      const outcome: Outcome = rateLimitedFor !== null
        ? { result: "retry", error: "rate limited", retryAfterSeconds: rateLimitedFor, rateLimited: true }
        : await deliver(item, buildReminderMessage(item, appUrl), botToken, wa);
      rateLimitedFor ??= rateLimit(outcome);

      const { data: finished, error: finishError } = await supabase.rpc("finish_reminder", {
        p_delivery_id: item.delivery_id,
        p_lease_token: item.lease_token,
        ...finishArgs(outcome),
        p_message_id: outcome.result === "sent" && "messageId" in outcome ? outcome.messageId ?? undefined : undefined,
      });
      // If recording fails after a successful send, the lease expires and the reminder may be sent again (at-least-once).
      if (finishError) console.error("finish failed", finishError.code);
      if (finished === "lease_lost") counts.lease_lost++;
      else counts[outcome.result]++;
      if (rateLimitedFor === null) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
    if (rateLimitedFor !== null || batch.length < BATCH_SIZE) break;
  }

  // Role-based notifications (lead/finance/library events, overdue alerts, digests), same lease and retry rules.
  const notified = { sent: 0, retry: 0, failed: 0, blocked: 0, hold: 0, lease_lost: 0 };
  while (Date.now() - started < MAX_RUNTIME_MS) {
    const { data, error } = await supabase.rpc("claim_due_notifications", { p_limit: BATCH_SIZE, p_lease_seconds: LEASE_SECONDS });
    if (error) {
      console.error("notification claim failed", error.code);
      break;
    }
    const batch = (data ?? []) as ClaimedNotification[];
    if (batch.length === 0) break;
    let rateLimitedFor: number | null = null;
    for (const item of batch) {
      const outcome: Outcome = rateLimitedFor !== null
        ? { result: "retry", error: "rate limited", retryAfterSeconds: rateLimitedFor, rateLimited: true }
        : await deliver(item, buildNotification(item, appUrl), botToken, wa);
      rateLimitedFor ??= rateLimit(outcome);
      const { data: finished, error: finishError } = await supabase.rpc("finish_notification", {
        p_id: item.notification_id,
        p_lease_token: item.lease_token,
        ...finishArgs(outcome),
      });
      if (finishError) console.error("notification finish failed", finishError.code);
      if (finished === "lease_lost") notified.lease_lost++;
      else notified[outcome.result]++;
      if (rateLimitedFor === null) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
    if (rateLimitedFor !== null || batch.length < BATCH_SIZE) break;
  }

  // WhatsApp: the free "keep alerts on" reminder before each window closes, and (only with a template
  // configured) the paid message to people whose window closed with alerts waiting. The database marks
  // each person, so a crash here skips that prompt rather than repeating it.
  const prompted = { nudge: 0, reopen: 0, failed: 0 };
  if (wa && Date.now() - started < MAX_RUNTIME_MS) {
    const { data, error } = await supabase.rpc("claim_whatsapp_prompts", { p_limit: BATCH_SIZE, p_reopen: !!reopenTemplate });
    if (error) console.error("prompt claim failed", error.code);
    for (const p of (data ?? []) as { wa_id: string; kind: "nudge" | "reopen"; name: string }[]) {
      const outcome = p.kind === "nudge"
        ? await sendWhatsApp(wa, p.wa_id, nudgeMessage(p.name))
        : await postWhatsApp(wa, templateBody(p.wa_id, reopenTemplate, templateLang));
      if (outcome.result === "sent") prompted[p.kind]++;
      else {
        prompted.failed++;
        console.error("prompt failed", p.kind, outcome.error);
      }
      await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
  }

  return Response.json({ ok: true, counts, notified, prompted });
});
