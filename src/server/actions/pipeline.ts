"use server";

import { z } from "zod";
import { LEAD_OUTCOMES } from "@/lib/constants";
import { dbError } from "@/lib/errors";
import { STAGE_COLORS } from "@/lib/stages";
import { runAction } from "@/server/action-utils";

const stageSchema = z.object({
  id: z.uuid().nullable(),
  name: z.string().trim().min(1, "Enter a name").max(40),
  kind: z.enum(LEAD_OUTCOMES),
  color: z.enum(STAGE_COLORS),
});

/** Adds (id null) or edits one of the company's pipeline stages. */
export async function savePipelineStage(input: unknown) {
  return runAction(["admin"], stageSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("save_pipeline_stage", { p_id: d.id as string, p_name: d.name, p_kind: d.kind, p_color: d.color });
    if (error) return dbError(error);
    return { ok: true, data: { id: data } };
  });
}

export async function reorderPipelineStages(input: unknown) {
  return runAction(["admin"], z.object({ ids: z.array(z.uuid()).min(1).max(100) }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("reorder_pipeline_stages", { p_ids: d.ids });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Archives a stage; its leads move to `moveTo` first (recorded in their timelines). */
export async function archivePipelineStage(input: unknown) {
  return runAction(["admin"], z.object({ id: z.uuid(), moveTo: z.uuid().optional() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("archive_pipeline_stage", { p_id: d.id, p_move_to: d.moveTo });
    if (error) return dbError(error);
    return { ok: true, data: { moved: data } };
  });
}
