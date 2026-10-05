"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { runAction } from "@/server/action-utils";
import { capitalSchema, expenseSchema } from "@/lib/validation";

const ROLES: ("admin" | "account")[] = ["admin", "account"];

export async function saveExpense(input: unknown) {
  return runAction(ROLES, expenseSchema, input, async (d, { supabase, profile }) => {
    const values = { expense_date: d.expenseDate, category: d.category, amount: d.amount as unknown as number, description: d.description ?? null };
    const q = d.id
      ? supabase.from("expenses").update(values).eq("id", d.id).is("archived_at", null)
      : supabase.from("expenses").insert({ ...values, created_by: profile.id });
    const { data, error } = await q.select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: { id: data.id } };
  });
}

export async function saveCapital(input: unknown) {
  return runAction(ROLES, capitalSchema, input, async (d, { supabase, profile }) => {
    const values = { entry_date: d.entryDate, contributor: d.contributor, amount: d.amount as unknown as number, description: d.description ?? null };
    const q = d.id
      ? supabase.from("capital_entries").update(values).eq("id", d.id).is("archived_at", null)
      : supabase.from("capital_entries").insert({ ...values, created_by: profile.id });
    const { data, error } = await q.select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: { id: data.id } };
  });
}

const archiveSchema = z.object({ kind: z.enum(["expense", "capital"]), id: z.uuid(), archived: z.boolean() });

export async function setFinanceArchived(input: unknown) {
  return runAction(ROLES, archiveSchema, input, async (d, { supabase }) => {
    const table = d.kind === "expense" ? "expenses" : "capital_entries";
    const { data, error } = await supabase
      .from(table)
      .update({ archived_at: d.archived ? new Date().toISOString() : null })
      .eq("id", d.id)
      .select("id")
      .maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: undefined };
  });
}
