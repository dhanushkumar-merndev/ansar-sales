"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { SHARE_EXPIRY, SHARE_MAX_FILES, type ShareExpiry } from "@/lib/library";
import { runAction } from "@/server/action-utils";

const LEAD_ROLES = ["admin", "sales"] as const satisfies ("admin" | "sales")[];

/** Creates (no id) or edits a share template: name, files in order, WhatsApp message and link expiry. */
export async function saveShareTemplate(input: unknown) {
  const schema = z.object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1, "Give the template a name").max(80, "At most 80 characters"),
    message: z.string().trim().max(1000, "At most 1000 characters"),
    expiry: z.enum(Object.keys(SHARE_EXPIRY) as [ShareExpiry, ...ShareExpiry[]]),
    fileIds: z.array(z.uuid()).min(1, "Pick at least one file").max(SHARE_MAX_FILES, `At most ${SHARE_MAX_FILES} files`),
  });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("save_share_template", {
      p_id: d.id ?? null, p_name: d.name, p_message: d.message, p_expiry: d.expiry, p_file_ids: d.fileIds,
    });
    if (error) return dbError(error);
    return { ok: true, data: { id: data as string } };
  });
}

/** Archives or restores a template (its creator or an admin). */
export async function setShareTemplateArchived(input: unknown) {
  return runAction([...LEAD_ROLES], z.object({ id: z.uuid(), archived: z.boolean() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_share_template_archived", { p_id: d.id, p_archived: d.archived });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}
