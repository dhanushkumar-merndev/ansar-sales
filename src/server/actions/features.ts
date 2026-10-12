"use server";

import { z } from "zod";
import { COMPANY_FEATURES } from "@/lib/constants";
import { dbError } from "@/lib/errors";
import { runAction } from "@/server/action-utils";

/** Super admin: switches an optional module (e.g. Projects for Star Gardens) on or off for a company. */
export async function setCompanyFeature(input: unknown) {
  const schema = z.object({ companyId: z.uuid(), feature: z.enum(COMPANY_FEATURES), enabled: z.boolean() });
  return runAction("super_admin", schema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("set_company_feature", { p_company_id: d.companyId, p_feature: d.feature, p_enabled: d.enabled });
    if (error) return dbError(error);
    return { ok: true, data: { features: data ?? [] } };
  });
}
