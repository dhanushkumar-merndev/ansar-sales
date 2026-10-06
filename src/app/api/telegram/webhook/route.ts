import { NextResponse, type NextRequest } from "next/server";
import { publicEnv, serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseSilenceCallback, parseStartCommand, safeEqual, withoutCallbackButtons } from "@/lib/telegram";
import { buildDashboard, NOT_CONNECTED_TEXT, parseIncomingText, type BotReply, type BotSummary } from "@/lib/telegram-bot";

/** Best-effort Bot API call; the CRM shows connection and delivery state either way. */
async function botApi(method: string, body: Record<string, unknown>) {
  try {
    await fetch(`https://api.telegram.org/bot${serverEnv("TELEGRAM_BOT_TOKEN")}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Ignored.
  }
}

const reply = (chatId: number, text: string, extra: Partial<Omit<BotReply, "text">> = {}) =>
  botApi("sendMessage", { chat_id: chatId, text, ...extra, link_preview_options: { is_disabled: true } });
const send = (chatId: number, r: BotReply) => reply(chatId, r.text, { reply_markup: r.reply_markup });

const appUrl = () => publicEnv.appUrl || null;

/** The connected user's role summary, or not connected. */
async function summaryFor(chatId: number): Promise<BotSummary> {
  const { data, error } = await createAdminClient().rpc("telegram_bot_summary", { p_chat_id: chatId });
  return error || !data ? { connected: false } : (data as unknown as BotSummary);
}

/** The user's dashboard summary. Also clears the "/" command menu an earlier version set for this chat. */
async function dashboard(chatId: number, summary: Extract<BotSummary, { connected: true }>) {
  await botApi("deleteMyCommands", { scope: { type: "chat", chat_id: chatId } });
  await send(chatId, buildDashboard(summary, appUrl()));
}

/** Telegram webhook: only accepts requests carrying our secret token header. */
export async function POST(request: NextRequest) {
  let secret: string;
  try {
    secret = serverEnv("TELEGRAM_WEBHOOK_SECRET");
  } catch {
    return new NextResponse(null, { status: 503 });
  }
  const header = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!safeEqual(header, secret)) return new NextResponse(null, { status: 401 });

  const update = await request.json().catch(() => null);

  // 🔕 Silence on an overdue alert. The database checks that this chat belongs to the assignee.
  const silence = parseSilenceCallback(update);
  if (silence) {
    const { data, error } = await createAdminClient().rpc("silence_follow_up_nag", {
      p_chat_id: silence.chatId,
      p_follow_up_id: silence.followUpId,
    });
    const result = data as { ok?: boolean; lead_name?: string } | null;
    const ok = !error && result?.ok;
    await botApi("answerCallbackQuery", {
      callback_query_id: silence.callbackId,
      text: ok ? `🔕 Overdue alerts silenced for ${result?.lead_name}` : "This alert can't be silenced from this chat.",
    });
    if (ok) {
      await botApi("editMessageReplyMarkup", {
        chat_id: silence.chatId,
        message_id: silence.messageId,
        reply_markup: withoutCallbackButtons(silence.keyboard),
      });
    }
    return NextResponse.json({ ok: true });
  }

  const start = parseStartCommand(update);
  if (!start) {
    // Any other private message: connected users get their role's dashboard summary.
    const incoming = parseIncomingText(update);
    if (incoming) {
      const summary = await summaryFor(incoming.chatId);
      if (summary.connected) await dashboard(incoming.chatId, summary);
      else await reply(incoming.chatId, NOT_CONNECTED_TEXT);
    }
    return NextResponse.json({ ok: true });
  }

  const { data, error } = await createAdminClient().rpc("consume_telegram_link_token", {
    p_token: start.token,
    p_chat_id: start.chatId,
    p_telegram_username: start.username ?? undefined,
  });
  const result = data as { ok?: boolean; display_name?: string } | null;
  if (error || !result?.ok) {
    await reply(start.chatId, "This link is invalid or has expired. Generate a new one from CRM Settings.");
  } else {
    await reply(start.chatId, `Connected. Hi ${result.display_name}! Your CRM alerts will arrive here.`);
    const summary = await summaryFor(start.chatId);
    if (summary.connected) await dashboard(start.chatId, summary);
  }
  // Always 200 so Telegram does not retry the update.
  return NextResponse.json({ ok: true });
}
