import { timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Extracts the linking token from a private-chat "/start <token>" message. */
export function parseStartCommand(update: unknown): { token: string; chatId: number; username: string | null } | null {
  const msg = (update as { message?: { text?: string; chat?: { id?: number; type?: string }; from?: { username?: string } } })?.message;
  if (!msg?.text || msg.chat?.type !== "private" || typeof msg.chat.id !== "number") return null;
  const match = /^\/start(?:@\w+)?\s+([a-f0-9]{64})$/.exec(msg.text.trim());
  if (!match) return null;
  return { token: match[1], chatId: msg.chat.id, username: msg.from?.username ?? null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InlineKeyboard = { inline_keyboard: ({ text: string; url?: string; callback_data?: string })[][] };

/**
 * A press of the 🔕 Silence button (callback data "s:<follow-up id>", built by the reminder
 * worker) in a private chat. The chat id is what authorizes the action, not the data.
 */
export function parseSilenceCallback(update: unknown): {
  callbackId: string; chatId: number; messageId: number; followUpId: string; keyboard: InlineKeyboard | null;
} | null {
  const cb = (update as {
    callback_query?: {
      id?: string; data?: string;
      message?: { message_id?: number; chat?: { id?: number; type?: string }; reply_markup?: InlineKeyboard };
    };
  })?.callback_query;
  if (!cb || typeof cb.id !== "string" || typeof cb.data !== "string") return null;
  const msg = cb.message;
  if (msg?.chat?.type !== "private" || typeof msg.chat.id !== "number" || typeof msg.message_id !== "number") return null;
  if (!cb.data.startsWith("s:")) return null;
  const followUpId = cb.data.slice(2);
  if (!UUID_RE.test(followUpId)) return null;
  return { callbackId: cb.id, chatId: msg.chat.id, messageId: msg.message_id, followUpId: followUpId.toLowerCase(), keyboard: msg.reply_markup ?? null };
}

/** The same keyboard without callback buttons (keeps "Open in CRM" after silencing). */
export function withoutCallbackButtons(keyboard: InlineKeyboard | null): InlineKeyboard {
  const rows = (keyboard?.inline_keyboard ?? []).map((row) => row.filter((b) => !b.callback_data)).filter((row) => row.length);
  return { inline_keyboard: rows };
}
