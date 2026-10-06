"use server";

import { z } from "zod";
import { COMPANY_LOGO_BUCKET } from "@/lib/companies";
import { dbError } from "@/lib/errors";
import { runAction } from "@/server/action-utils";

const nameSchema = z.string().trim().min(1, "Enter a name").max(80);
const highlightSchema = z.string().trim().max(40).optional();

/**
 * Super admin (any company) or ads manager (an assigned one): work inside another company.
 * The database keeps the choice and checks it, so RLS and Realtime follow it.
 */
export async function switchCompany(input: unknown) {
  return runAction(["admin", "ads_manager"], z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_active_company", { p_company_id: d.id });
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
    logoPath: z.string().max(300).optional(),
    clearLogo: z.boolean().optional(),
  });
  return runAction("super_admin", schema, input, async (d, { supabase }) => {
    const { data: before } = await supabase.from("companies").select("logo_path").eq("id", d.id).maybeSingle();
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
      await supabase.storage.from(COMPANY_LOGO_BUCKET).remove([before.logo_path]);
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
