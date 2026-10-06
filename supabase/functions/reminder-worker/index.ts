// Reminder and notification delivery worker. Invoked every minute by Supabase Cron (pg_net) only
// when reminders are due. Authenticated with a dedicated secret header.
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildNotification, buildReminderMessage, classifyTelegramResult, constantTimeEqual, replyMarkup, type ClaimedNotification, type ClaimedReminder, type DeliveryOutcome, type TelegramMessage } from "./logic.ts";

const BATCH_SIZE = 25;
const LEASE_SECONDS = 120;
const MAX_RUNTIME_MS = 20_000;
const SEND_GAP_MS = 50; // stays well below Telegram's ~30 msg/s bot limit

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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = Deno.env.get("REMINDER_WORKER_SECRET") ?? "";
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
  if (!secret || !botToken) return Response.json({ error: "worker not configured" }, { status: 500 });
  if (!constantTimeEqual(req.headers.get("x-worker-secret") ?? "", secret)) return new Response("Unauthorized", { status: 401 });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const appUrl = Deno.env.get("APP_URL") ?? null;
  const started = Date.now();
  const counts = { sent: 0, retry: 0, failed: 0, blocked: 0, lease_lost: 0 };

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
      // After a 429, put the rest of the batch back with Telegram's retry_after instead of hammering the API.
      const outcome: DeliveryOutcome = rateLimitedFor !== null
        ? { result: "retry", error: "rate limited", retryAfterSeconds: rateLimitedFor, rateLimited: true }
        : await sendTelegram(botToken, item.chat_id, buildReminderMessage(item, appUrl));
      if (outcome.result === "retry" && outcome.rateLimited) rateLimitedFor = outcome.retryAfterSeconds;

      const { data: finished, error: finishError } = await supabase.rpc("finish_reminder", {
        p_delivery_id: item.delivery_id,
        p_lease_token: item.lease_token,
        p_result: outcome.result,
        p_error: outcome.result === "sent" ? undefined : outcome.error,
        p_retry_after_seconds: outcome.result === "retry" ? outcome.retryAfterSeconds ?? undefined : undefined,
        p_message_id: outcome.result === "sent" ? outcome.messageId ?? undefined : undefined,
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
  const notified = { sent: 0, retry: 0, failed: 0, blocked: 0, lease_lost: 0 };
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
      const outcome: DeliveryOutcome = rateLimitedFor !== null
        ? { result: "retry", error: "rate limited", retryAfterSeconds: rateLimitedFor, rateLimited: true }
        : await sendTelegram(botToken, item.chat_id, buildNotification(item, appUrl));
      if (outcome.result === "retry" && outcome.rateLimited) rateLimitedFor = outcome.retryAfterSeconds;
      const { data: finished, error: finishError } = await supabase.rpc("finish_notification", {
        p_id: item.notification_id,
        p_lease_token: item.lease_token,
        p_result: outcome.result,
        p_error: outcome.result === "sent" ? undefined : outcome.error,
        p_retry_after_seconds: outcome.result === "retry" ? outcome.retryAfterSeconds ?? undefined : undefined,
      });
      if (finishError) console.error("notification finish failed", finishError.code);
      if (finished === "lease_lost") notified.lease_lost++;
      else notified[outcome.result]++;
      if (rateLimitedFor === null) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
    if (rateLimitedFor !== null || batch.length < BATCH_SIZE) break;
  }

  return Response.json({ ok: true, counts, notified });
});
