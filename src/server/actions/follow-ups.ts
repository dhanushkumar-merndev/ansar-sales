"use server";

import { z } from "zod";
import type { TablesInsert } from "@/lib/database.types";
import { dbError } from "@/lib/errors";
import { runAction } from "@/server/action-utils";
import { followUpCompleteSchema, followUpRescheduleSchema, followUpScheduleSchema } from "@/lib/validation";

const ROLES: ("admin" | "sales")[] = ["admin", "sales"];

export async function scheduleFollowUp(input: unknown) {
  return runAction(ROLES, followUpScheduleSchema, input, async (d, { supabase, profile }) => {
    // assignee_id is always set by the database to the lead's current owner (not client-writable).
    const row = { lead_id: d.leadId, task: d.task, due_at: d.dueAt, created_by: profile.id } as TablesInsert<"follow_ups">;
    const { error } = await supabase.from("follow_ups").insert(row);
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function rescheduleFollowUp(input: unknown) {
  return runAction(ROLES, followUpRescheduleSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase
      .from("follow_ups")
      .update({ task: d.task, due_at: d.dueAt })
      .eq("id", d.id)
      .eq("state", "pending")
      .select("id")
      .maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found_or_closed" });
    return { ok: true, data: undefined };
  });
}

export async function completeFollowUp(input: unknown) {
  return runAction(ROLES, followUpCompleteSchema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("complete_follow_up", {
      p_id: d.id,
      p_outcome: d.outcome,
      p_next_due_at: d.nextDueAt,
      p_next_task: d.nextTask,
    });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function cancelFollowUp(input: unknown) {
  return runAction(ROLES, z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase
      .from("follow_ups")
      .update({ state: "cancelled" })
      .eq("id", d.id)
      .eq("state", "pending")
      .select("id")
      .maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found_or_closed" });
    return { ok: true, data: undefined };
  });
}
