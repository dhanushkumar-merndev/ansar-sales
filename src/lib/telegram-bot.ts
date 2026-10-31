// What the Telegram bot says back when a connected user messages it: their role's dashboard
// summary, nothing else. Pure functions (no I/O): the webhook fetches the summary
// (public.telegram_bot_summary) and sends what these return.
import { dashboardLines, type BotSummary } from "../../supabase/functions/_shared/bot-summary";

export type { BotSummary };
type Connected = Extract<BotSummary, { connected: true }>;

/**
 * The reply. It always removes the custom keyboard (an earlier version of the bot showed
 * Today / Test / Help buttons), so the CRM link is part of the text rather than a button.
 */
export type BotReply = { text: string; reply_markup: { remove_keyboard: true } };

/** Text of a private-chat message (anything but "/start <token>", which the webhook handles first). */
export function parseIncomingText(update: unknown): { chatId: number; text: string } | null {
  const msg = (update as { message?: { text?: string; chat?: { id?: number; type?: string } } })?.message;
  if (msg?.chat?.type !== "private" || typeof msg.chat.id !== "number") return null;
  return { chatId: msg.chat.id, text: (msg.text ?? "").trim() };
}

/** The role's short dashboard: whatever is most worth knowing right now. */
export function buildDashboard(s: Connected, appUrl: string | null): BotReply {
  return { text: dashboardLines(s, appUrl).join("\n"), reply_markup: { remove_keyboard: true } };
}

export const NOT_CONNECTED_TEXT = "To receive CRM alerts here, open Settings in the CRM and use “Connect Telegram”.";
