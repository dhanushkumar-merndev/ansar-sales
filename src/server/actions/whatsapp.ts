"use server";

import { z } from "zod";
import { publicEnv, whatsappNumber } from "@/lib/env";
import { dbError } from "@/lib/errors";
import type { AppRole } from "@/lib/constants";
import { buildLinkUrl } from "../../../supabase/functions/_shared/whatsapp";
import { runAction } from "@/server/action-utils";

/** Everyone with a staff login can get alerts on their phone. */
const STAFF: AppRole[] = ["admin", "sales", "account", "ads_manager", "architect_manager", "landscape_designer", "execution"];

/**
 * A wa.me link that opens WhatsApp with a one-time code typed in (valid 10 minutes, once). Sending it from
 * the person's own WhatsApp links that number: Meta's signed webhook is the proof, nobody types a number.
 */
export async function createWhatsAppLink() {
  return runAction(STAFF, z.undefined(), undefined, async (_d, { supabase }) => {
    const number = whatsappNumber();
    if (!number) return { ok: false, error: "WhatsApp is not set up yet. Ask the super admin." };
    const { data, error } = await supabase.rpc("create_whatsapp_link");
    if (error) return dbError(error);
    const code = String(data);
    return { ok: true, data: { url: buildLinkUrl(number, code), code, number: `+${number}`, expiresInMinutes: 10 } };
  });
}

export async function disconnectWhatsApp() {
  return runAction(STAFF, z.undefined(), undefined, async (_d, { supabase }) => {
    const { error } = await supabase.rpc("disconnect_whatsapp");
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Where alerts go: Telegram or WhatsApp (it must be linked). */
export async function setNotifyChannel(input: unknown) {
  return runAction(STAFF, z.object({ channel: z.enum(["telegram", "whatsapp"]) }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_notify_channel", { p_channel: d.channel });
    if (error) return dbError(error);
    return { ok: true, data: d.channel };
  });
}

/** For Super settings: the business number and the webhook address to paste into Meta (no secrets). */
export async function whatsappSetupInfo() {
  return runAction("super_admin", z.undefined(), undefined, async () => {
    const number = whatsappNumber();
    return {
      ok: true,
      data: {
        number: number ? `+${number}` : null,
        webhookUrl: publicEnv.supabaseUrl ? `${publicEnv.supabaseUrl.replace(/\/+$/, "")}/functions/v1/whatsapp-webhook` : null,
      },
    };
  });
}
