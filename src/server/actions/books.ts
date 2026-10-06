"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { runAction } from "@/server/action-utils";

/** Super admin: one set of books for these companies. `editorIds` may add or change entries; the rest view only. */
export async function mergeBooks(input: unknown) {
  const schema = z.object({ companyIds: z.array(z.uuid()).min(2).max(50), editorIds: z.array(z.uuid()).min(1).max(50) });
  return runAction("super_admin", schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("merge_finance", { p_company_ids: d.companyIds, p_editor_ids: d.editorIds });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Super admin: give a company its own books again (its entries go with it). */
export async function splitBooks(input: unknown) {
  return runAction("super_admin", z.object({ companyId: z.uuid() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("split_finance", { p_company_id: d.companyId });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Super admin: which companies of merged books may edit them. */
export async function setBookEditors(input: unknown) {
  return runAction("super_admin", z.object({ companyIds: z.array(z.uuid()).min(1).max(50) }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_finance_editors", { p_company_ids: d.companyIds });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Rename or archive/restore an expense category of the user's books. */
export async function updateExpenseCategory(input: unknown) {
  const schema = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(40).optional(), archived: z.boolean().optional() });
  return runAction(["admin", "account"], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("update_expense_category", { p_id: d.id, p_name: d.name, p_archived: d.archived });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}
