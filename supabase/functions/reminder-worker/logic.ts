// Pure helpers for the reminder worker (no Deno/Node APIs) so they can be unit tested.

export type ClaimedReminder = {
  delivery_id: string;
  lease_token: string;
  chat_id: number;
  lead_id: string;
  lead_name: string;
  lead_phone: string | null;
  task: string;
  due_at: string;
  attempts: number;
};

export type DeliveryOutcome =
  | { result: "sent"; messageId: number | null }
  | { result: "retry"; error: string; retryAfterSeconds: number | null; rateLimited: boolean }
  | { result: "failed"; error: string }
  | { result: "blocked"; error: string };

const istFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
});

export function buildReminderMessage(r: ClaimedReminder, appUrl: string | null): string {
  const lines = [
    "⏰ Follow-up due",
    `Lead: ${r.lead_name}`,
    `Task: ${r.task}`,
    `Due: ${istFmt.format(new Date(r.due_at))} IST`,
  ];
  // The recipient is always the lead's current owner (checked at claim time), so the phone is permitted.
  if (r.lead_phone) lines.push(`Phone: ${r.lead_phone}`);
  if (appUrl) lines.push(`Open: ${appUrl.replace(/\/+$/, "")}/leads/${r.lead_id}`);
  return lines.join("\n").slice(0, 4000);
}

/** Removes anything that looks like a bot token or URL and bounds the length. */
export function sanitizeError(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, "<redacted>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .slice(0, 300);
}

type TelegramBody = { ok?: boolean; description?: string; error_code?: number; parameters?: { retry_after?: number }; result?: { message_id?: number } };

/** Maps a Telegram Bot API response to a delivery outcome. `status` 0 = network error/timeout. */
export function classifyTelegramResult(status: number, body: TelegramBody | null): DeliveryOutcome {
  if (status === 200 && body?.ok) return { result: "sent", messageId: body.result?.message_id ?? null };
  const description = sanitizeError(body?.description ?? (status === 0 ? "network error" : `HTTP ${status}`));
  if (status === 429) {
    return { result: "retry", error: `rate limited: ${description}`, retryAfterSeconds: body?.parameters?.retry_after ?? 30, rateLimited: true };
  }
  if (status === 403 || (status === 400 && /chat not found|user is deactivated/i.test(description))) {
    return { result: "blocked", error: description };
  }
  if (status === 0 || status >= 500) return { result: "retry", error: description, retryAfterSeconds: null, rateLimited: false };
  return { result: "failed", error: description };
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
