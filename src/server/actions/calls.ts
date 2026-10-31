"use server";

import { z } from "zod";
import { LEAD_TEMPERATURES } from "@/lib/constants";
import { dbError } from "@/lib/errors";
import { CALL_OUTCOMES, type CallOutcome } from "@/lib/library";
import { runAction } from "@/server/action-utils";

const LEAD_ROLES = ["admin", "sales"] as const satisfies ("admin" | "sales")[];

/** Records "called the lead" in the timeline; the outcome is added afterwards. */
export async function logCall(input: unknown) {
  return runAction([...LEAD_ROLES], z.object({ leadId: z.uuid() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("log_call", { p_lead_id: d.leadId });
    if (error) return dbError(error);
    return { ok: true, data: { activityId: data } };
  });
}

export async function setCallOutcome(input: unknown) {
  const schema = z.object({
    activityId: z.uuid(),
    outcome: z.enum(Object.keys(CALL_OUTCOMES) as [CallOutcome, ...CallOutcome[]]),
    note: z.string().trim().max(1000, "At most 1000 characters").optional(),
  });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_call_outcome", { p_activity_id: d.activityId, p_outcome: d.outcome, p_note: d.note || undefined });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/**
 * The call screen's Save: the call's result and note, then (when picked) the lead's status and
 * temperature, all or nothing, logged in that order. temperature: undefined = unchanged, null = clear.
 */
export async function finishCall(input: unknown) {
  const schema = z.object({
    activityId: z.uuid(),
    outcome: z.enum(Object.keys(CALL_OUTCOMES) as [CallOutcome, ...CallOutcome[]]),
    note: z.string().trim().max(1000, "At most 1000 characters").optional(),
    stageId: z.uuid().optional(),
    temperature: z.enum(LEAD_TEMPERATURES).nullable().optional(),
  });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("finish_call", {
      p_activity_id: d.activityId,
      p_outcome: d.outcome,
      p_note: d.note || undefined,
      p_stage_id: d.stageId,
      p_set_temperature: d.temperature !== undefined,
      p_temperature: d.temperature ?? null,
    });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Records (or corrects) how long a call lasted: the caller within a day, an admin any time. */
export async function setCallDuration(input: unknown) {
  const schema = z.object({ activityId: z.uuid(), seconds: z.number().int().min(0).max(86400) });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_call_duration", { p_activity_id: d.activityId, p_seconds: d.seconds });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}
