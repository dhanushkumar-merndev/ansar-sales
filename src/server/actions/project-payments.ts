"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { milestoneSchema, paymentSchema } from "@/lib/project-validation";
import { formatINR } from "@/lib/format";
import { scheduleExcess, scheduleExcessMessage, splitByPercent, sumAmounts } from "@/lib/projects";
import { runAction } from "@/server/action-utils";

// Admin and Accounts only; RLS (can_see_project_money) enforces the same in the database.
const MONEY = ["admin", "account"] as const;
const changed = () => dbError({ message: "project_changed" });

/** The schedule may not ask for more than the contract value; Accounts raises the value first if the scope grew. */
const overValue = (total: number, value: unknown) => ({ ok: false as const, error: scheduleExcessMessage(total, value), code: "schedule_over_value" });

export async function saveMilestone(input: unknown) {
  return runAction([...MONEY], milestoneSchema, input, async (d, { supabase }) => {
    const row = {
      label: d.label, percent: d.percent, amount: d.amount as unknown as number, due_trigger: d.dueTrigger,
      due_date: d.dueTrigger === "date" ? d.dueDate! : null, phase_id: d.dueTrigger === "phase" ? d.phaseId! : null, notes: d.notes ?? null,
    };
    const [{ data: fin }, { data: parts, error: pe }] = await Promise.all([
      supabase.from("project_financials").select("contract_value").eq("project_id", d.projectId).maybeSingle(),
      supabase.from("project_payment_milestones").select("id, amount").eq("project_id", d.projectId).is("archived_at", null),
    ]);
    if (pe) return dbError(pe);
    const total = sumAmounts([...(parts ?? []).filter((m) => m.id !== d.id).map((m) => m.amount), d.amount]);
    if (scheduleExcess(fin?.contract_value, total)) return overValue(total, fin?.contract_value);
    if (!d.id) {
      const { data: last } = await supabase.from("project_payment_milestones").select("position").eq("project_id", d.projectId)
        .is("archived_at", null).order("position", { ascending: false }).limit(1).maybeSingle();
      const { error } = await supabase.from("project_payment_milestones").insert({ ...row, project_id: d.projectId, position: (last?.position ?? 0) + 1 });
      if (error) return dbError(error);
      return { ok: true, data: undefined };
    }
    const { data, error } = await supabase.from("project_payment_milestones").update(row)
      .eq("id", d.id).eq("version", d.version ?? 0).is("archived_at", null).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return changed();
    return { ok: true, data: undefined };
  });
}

export async function archiveMilestone(input: unknown) {
  return runAction([...MONEY], z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_payment_milestones").update({ archived_at: new Date().toISOString() })
      .eq("id", d.id).is("archived_at", null).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: undefined };
  });
}

/** Re-derives each part's amount from its percent of the current contract value. */
export async function recalcMilestones(input: unknown) {
  return runAction([...MONEY], z.object({ projectId: z.uuid() }), input, async (d, { supabase }) => {
    const [{ data: fin }, { data: ms, error }] = await Promise.all([
      supabase.from("project_financials").select("contract_value").eq("project_id", d.projectId).maybeSingle(),
      supabase.from("project_payment_milestones").select("id, percent").eq("project_id", d.projectId).is("archived_at", null).order("position").order("id"),
    ]);
    if (error) return dbError(error);
    const value = Number(fin?.contract_value ?? 0);
    const withPct = (ms ?? []).filter((m) => m.percent != null);
    if (!value || !withPct.length) return { ok: false, error: "Set the contract value and the percent of each part first." };
    const total = withPct.reduce((s, m) => s + Number(m.percent), 0);
    if (total > 100) {
      return { ok: false, error: `The percentages add up to ${total}%, so the parts would come to more than the contract value (${formatINR(value)}). Bring them down to 100% first.`, code: "schedule_over_value" };
    }
    // Exact split of the part of the value the percents cover (e.g. 100% → all of it).
    const amounts = splitByPercent((value * total) / 100, withPct.map((m) => (Number(m.percent) / total) * 100));
    for (const [i, m] of withPct.entries()) {
      const { error: e } = await supabase.from("project_payment_milestones").update({ amount: amounts[i] as unknown as number }).eq("id", m.id);
      if (e) return dbError(e);
    }
    return { ok: true, data: undefined };
  });
}

export async function savePayment(input: unknown) {
  return runAction([...MONEY], paymentSchema, input, async (d, { supabase }) => {
    const row = {
      is_extra: d.isExtra, amount: d.amount as unknown as number, paid_on: d.paidOn, mode: d.mode,
      reference: d.reference ?? null, notes: d.notes ?? null,
    };
    if (!d.id) {
      const { data, error } = await supabase.from("project_payments").insert({ ...row, project_id: d.projectId }).select("id").single();
      if (error) return dbError(error);
      return { ok: true, data: { id: data.id } };
    }
    const { data, error } = await supabase.from("project_payments").update(row)
      .eq("id", d.id).eq("version", d.version ?? 0).is("archived_at", null).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return changed();
    return { ok: true, data: { id: data.id } };
  });
}

export async function archivePayment(input: unknown) {
  return runAction([...MONEY], z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_payments").update({ archived_at: new Date().toISOString() })
      .eq("id", d.id).is("archived_at", null).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: undefined };
  });
}
