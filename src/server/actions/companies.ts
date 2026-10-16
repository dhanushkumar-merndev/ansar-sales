"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { confirmUpload, deleteObjects, forgetObjects } from "@/lib/storage";
import { LOGO_MAX_BYTES, LOGO_MIME_TYPES, LOGO_PATH_RE } from "@/lib/storage-paths";
import { runAction } from "@/server/action-utils";

const nameSchema = z.string().trim().min(1, "Enter a name").max(80);
const highlightSchema = z.string().trim().max(40).optional();

/**
 * Super admin (any company), ads manager (an assigned one) or a sales user (one the super admin ticked
 * for them): work inside another company. The database keeps the choice and checks it, so RLS and
 * Realtime follow it.
 */
export async function switchCompany(input: unknown) {
  return runAction(["admin", "ads_manager", "sales"], z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_active_company", { p_company_id: d.id });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Super admin: the other companies of ours a sales user also works in (replaces the list). */
export async function setSalesUserCompanies(input: unknown) {
  return runAction("super_admin", z.object({ id: z.uuid(), companyIds: z.array(z.uuid()).max(50) }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_sales_user_companies", { p_user_id: d.id, p_company_ids: d.companyIds });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function createCompany(input: unknown) {
  return runAction("super_admin", z.object({ name: nameSchema, brandHighlight: highlightSchema }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("create_company", { p_name: d.name, p_brand_highlight: d.brandHighlight || undefined });
    if (error) return dbError(error);
    return { ok: true, data: { id: data } };
  });
}

export async function updateCompany(input: unknown) {
  const schema = z.object({
    id: z.uuid(),
    name: nameSchema.optional(),
    // "" clears the highlight word.
    brandHighlight: z.string().trim().max(40).optional(),
    logoPath: z.string().regex(LOGO_PATH_RE).optional(),
    clearLogo: z.boolean().optional(),
  });
  return runAction("super_admin", schema, input, async (d, { supabase }) => {
    const { data: before } = await supabase.from("companies").select("logo_path").eq("id", d.id).maybeSingle();
    if (d.logoPath && d.logoPath !== before?.logo_path) {
      if (!d.logoPath.startsWith(`${d.id}/`)) return dbError({ message: "invalid_file" });
      const problem = await confirmUpload("logos", d.logoPath, { mimes: Object.keys(LOGO_MIME_TYPES), maxBytes: LOGO_MAX_BYTES });
      if (problem) return dbError({ message: problem });
    }
    const { error } = await supabase.rpc("update_company", {
      p_company_id: d.id,
      p_name: d.name,
      p_brand_highlight: d.brandHighlight,
      p_logo_path: d.logoPath,
      p_clear_logo: d.clearLogo ?? false,
    });
    if (error) return dbError(error);
    // The old logo file is no longer referenced; removing it is best-effort.
    if (before?.logo_path && (d.clearLogo || (d.logoPath && d.logoPath !== before.logo_path))) {
      try {
        if (!(await deleteObjects("logos", [before.logo_path])).length) await forgetObjects("logos", [before.logo_path]);
      } catch {
        // ignored
      }
    }
    return { ok: true, data: undefined };
  });
}

export type CompanySummary = {
  id: string; name: string; brand_highlight: string | null; logo_path: string | null;
  created_at: string; archived_at: string | null; users: number; admins: number; leads: number;
};

export async function listCompanies() {
  return runAction("super_admin", z.object({}).strict(), {}, async (_d, { supabase }) => {
    const { data, error } = await supabase.rpc("super_list_companies");
    if (error) return dbError(error);
    return { ok: true, data: (data ?? []) as CompanySummary[] };
  });
}
