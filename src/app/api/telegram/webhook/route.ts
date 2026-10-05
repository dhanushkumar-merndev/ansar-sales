import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseStartCommand, safeEqual } from "@/lib/telegram";

async function reply(chatId: number, text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${serverEnv("TELEGRAM_BOT_TOKEN")}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Best effort; the CRM shows the connection state either way.
  }
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
  const start = parseStartCommand(update);
  if (!start) {
    const chatId = (update as { message?: { chat?: { id?: number; type?: string } } })?.message?.chat;
    if (chatId?.type === "private" && typeof chatId.id === "number") {
      await reply(chatId.id, "To receive CRM reminders, open Settings in the CRM and use “Connect Telegram”.");
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
    await reply(start.chatId, `Connected. Hi ${result.display_name}! Follow-up reminders will arrive here.`);
  }
  // Always 200 so Telegram does not retry the update.
  return NextResponse.json({ ok: true });
}
