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

/** Turns one notification type on or off for the signed-in user, in the app or on Telegram (the database checks the role). */
export async function setNotificationPref(input: unknown) {
  const schema = z.object({ kind: z.enum(KIND_VALUES), enabled: z.boolean(), channel: z.enum(["telegram", "app"]).default("telegram") });
  return runAction(ALL, schema, input, async (d, { supabase }) => {
    // Without the channel argument this is the older database's two-argument call (Telegram only).
    const { data, error } = await supabase.rpc("set_notification_pref",
      d.channel === "telegram" ? { p_kind: d.kind, p_enabled: d.enabled } : { p_kind: d.kind, p_enabled: d.enabled, p_channel: d.channel });
    if (error) return dbError(error);
    return { ok: true, data: data ?? [] };
  });
}

/** Marks the given notifications (or, without ids, all of them) read; returns how many are still unread. */
export async function markNotificationsRead(input: unknown) {
  return runAction(ALL, z.object({ ids: z.array(z.uuid()).min(1).max(200).optional() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("mark_notifications_read", d.ids ? { p_ids: d.ids } : {});
    if (error) return dbError(error);
    return { ok: true, data: { unread: Number(data ?? 0) } };
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
