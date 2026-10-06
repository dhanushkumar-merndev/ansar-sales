#!/usr/bin/env node
// Registers the CRM webhook with Telegram (with the secret header) and shows its status.
// Usage: pnpm telegram:webhook
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
if (!token || !secret || !appUrl.startsWith("https://")) {
  console.error("Need TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and an https NEXT_PUBLIC_APP_URL.");
  process.exit(1);
}
const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const set = await api("setWebhook", {
  url: `${appUrl}/api/telegram/webhook`,
  secret_token: secret,
  allowed_updates: ["message", "callback_query"], // callback_query: 🔕 Silence buttons
  drop_pending_updates: true,
});
console.log("setWebhook:", set.ok ? "ok" : set.description);
const info = await api("getWebhookInfo");
console.log("webhook url:", info.result?.url, "| pending:", info.result?.pending_update_count, "| last error:", info.result?.last_error_message ?? "none");
