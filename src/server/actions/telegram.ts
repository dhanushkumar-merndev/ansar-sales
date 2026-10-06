"use server";

import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { dbError } from "@/lib/errors";
import { NOTIFICATION_KINDS } from "@/lib/notifications";
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

const KIND_VALUES = NOTIFICATION_KINDS.map((k) => k.kind) as [string, ...string[]];

/** Turns one notification type on or off for the signed-in user (the database checks the role). */
export async function setNotificationPref(input: unknown) {
  return runAction(ALL, z.object({ kind: z.enum(KIND_VALUES), enabled: z.boolean() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("set_notification_pref", { p_kind: d.kind, p_enabled: d.enabled });
    if (error) return dbError(error);
    return { ok: true, data: data ?? [] };
  });
}

/** Queues a test message to the signed-in user's Telegram (delivered by the worker within about a minute). */
export async function sendTestNotification() {
  return runAction(ALL, z.undefined(), undefined, async (_d, { supabase }) => {
    const { error } = await supabase.rpc("send_test_notification");
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}
