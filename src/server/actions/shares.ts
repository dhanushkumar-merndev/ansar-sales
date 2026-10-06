"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { publicEnv } from "@/lib/env";
import { dbError } from "@/lib/errors";
import { SHARE_EXPIRY, SHARE_MAX_FILES, type ShareExpiry } from "@/lib/library";
import { runAction } from "@/server/action-utils";

const LEAD_ROLES = ["admin", "sales"] as const satisfies ("admin" | "sales")[];

async function appOrigin() {
  if (publicEnv.appUrl) return publicEnv.appUrl.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}

/**
 * Adds documents to the lead's single share link (creating it the first time) and
 * resets its expiry. The URL stays the same until the link is revoked.
 */
export async function shareLeadFiles(input: unknown) {
  const schema = z.object({
    leadId: z.uuid(),
    fileIds: z.array(z.uuid()).min(1, "Pick at least one file").max(SHARE_MAX_FILES, `At most ${SHARE_MAX_FILES} files at once`),
    expiry: z.enum(Object.keys(SHARE_EXPIRY) as [ShareExpiry, ...ShareExpiry[]]),
  });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("share_lead_files", { p_lead_id: d.leadId, p_file_ids: d.fileIds, p_expiry: d.expiry });
    if (error) return dbError(error);
    const r = data as { token: string; share_id: string; expires_at: string | null; created: boolean; added: number };
    return { ok: true, data: { url: `${await appOrigin()}/s/${r.token}`, shareId: r.share_id, expiresAt: r.expires_at, created: r.created, added: r.added } };
  });
}

export async function removeShareFile(input: unknown) {
  return runAction([...LEAD_ROLES], z.object({ shareId: z.uuid(), fileId: z.uuid() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("remove_share_file", { p_share_id: d.shareId, p_file_id: d.fileId });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function revokeLeadShare(input: unknown) {
  return runAction([...LEAD_ROLES], z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("revoke_lead_share", { p_share_id: d.id });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}
