"use server";

import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { dbError } from "@/lib/errors";
import { runAction } from "@/server/action-utils";

const ALL: ("admin" | "sales" | "account")[] = ["admin", "sales", "account"];

/** Returns a t.me deep link carrying a short-lived single-use token for the signed-in user. */
export async function createTelegramLink() {
  return runAction(ALL, z.undefined(), undefined, async (_d, { supabase }) => {
    let bot: string;
    try {
      bot = serverEnv("TELEGRAM_BOT_USERNAME");
    } catch {
      return { ok: false, error: "Telegram is not configured yet. Ask an admin to set up the bot." };
    }
    const { data, error } = await supabase.rpc("create_telegram_link_token");
    if (error) return dbError(error);
    return { ok: true, data: { url: `https://t.me/${bot}?start=${data}`, expiresInMinutes: 15 } };
  });
}

export async function disconnectTelegram() {
  return runAction(ALL, z.undefined(), undefined, async (_d, { supabase }) => {
    const { error } = await supabase.rpc("disconnect_telegram");
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}
