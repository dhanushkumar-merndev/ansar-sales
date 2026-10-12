"use server";

import type { AppRole } from "@/lib/constants";
import type { Json, TablesUpdate } from "@/lib/database.types";
import { dbError } from "@/lib/errors";
import { checkInSchema, visitScheduleSchema, visitUpdateSchema } from "@/lib/project-validation";
import { runAction } from "@/server/action-utils";

/** Who may plan or run visits; the database checks the lead / project per visit. */
const VISIT_ROLES: AppRole[] = ["admin", "sales", "architect_manager", "landscape_designer"];

export async function scheduleVisit(input: unknown) {
  return runAction(VISIT_ROLES, visitScheduleSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("site_visits").insert({
      project_id: d.projectId ?? null, lead_id: d.leadId ?? null, assigned_to: d.assignedTo, scheduled_at: d.scheduledAt, purpose: d.purpose,
    }).select("id").single();
    if (error) return dbError(error);
    return { ok: true, data: { id: data.id } };
  });
}

export async function updateVisit(input: unknown) {
  return runAction(VISIT_ROLES, visitUpdateSchema, input, async (d, { supabase }) => {
    const patch: TablesUpdate<"site_visits"> = {};
    if (d.assignedTo !== undefined) patch.assigned_to = d.assignedTo;
    if (d.scheduledAt !== undefined) patch.scheduled_at = d.scheduledAt;
    if (d.purpose !== undefined) patch.purpose = d.purpose;
    if (d.status !== undefined) patch.status = d.status;
    if (d.notes !== undefined) patch.notes = d.notes as Json;
    if (d.measurements !== undefined) patch.measurements = d.measurements;
    if (d.outcome !== undefined) patch.outcome = d.outcome;
    const { data, error } = await supabase.from("site_visits").update(patch).eq("id", d.id).eq("version", d.version).select("version").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "project_changed" });
    return { ok: true, data: { version: data.version } };
  });
}

export async function checkInVisit(input: unknown) {
  return runAction(VISIT_ROLES, checkInSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("site_visit_check_in", {
      p_visit_id: d.id, p_lat: d.lat, p_lng: d.lng, p_accuracy: d.accuracy, p_set_pin: d.setPin,
    });
    if (error) return dbError(error);
    return { ok: true, data: data as unknown as { distance_m: number | null; pinned: boolean } };
  });
}
