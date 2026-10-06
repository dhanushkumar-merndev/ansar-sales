"use server";

import { z } from "zod";
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
