"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { runAction } from "@/server/action-utils";
import { capitalSchema, expenseSchema } from "@/lib/validation";

const ROLES: ("admin" | "account")[] = ["admin", "account"];

export async function saveExpense(input: unknown) {
  return runAction(ROLES, expenseSchema, input, async (d, { supabase, profile }) => {
    // An existing category of these books, or a new one created by name (only by companies that may edit).
    const { data: categoryId, error: categoryError } = await supabase.rpc("resolve_expense_category", {
      p_id: d.category.id, p_new_name: d.category.id ? undefined : d.category.newName,
    });
    if (categoryError) return dbError(categoryError);
    const values = {
      expense_date: d.expenseDate, category_id: categoryId, amount: d.amount as unknown as number,
      ...(d.companyId ? { company_id: d.companyId } : {}),
      payment_mode: d.paymentMode, item: d.item ?? null, quantity: d.quantity ?? null, description: d.description ?? null,
    };
    const q = d.id
      ? supabase.from("expenses").update(values).eq("id", d.id).is("archived_at", null)
      : supabase.from("expenses").insert({ ...values, created_by: profile.id });
    const { data, error } = await q.select("id, recurrence_id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    // The saved expense becomes the template of its monthly series (or stops it).
    if (d.repeatMonthly || data.recurrence_id) {
      const { error: recurrenceError } = await supabase.rpc("set_expense_recurrence", { p_expense_id: data.id, p_repeat: d.repeatMonthly });
      if (recurrenceError) return dbError(recurrenceError);
    }
    return { ok: true, data: { id: data.id } };
  });
}

export async function saveCapital(input: unknown) {
  return runAction(ROLES, capitalSchema, input, async (d, { supabase, profile }) => {
    const values = {
      entry_date: d.entryDate, contributor: d.contributor, amount: d.amount as unknown as number,
      ...(d.companyId ? { company_id: d.companyId } : {}),
      payment_mode: d.paymentMode, item: d.item ?? null, quantity: d.quantity ?? null, description: d.description ?? null,
    };
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
