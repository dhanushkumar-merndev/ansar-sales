"use server";

import { updateTag } from "next/cache";
import { z } from "zod";
import { LEAD_TEMPERATURES } from "@/lib/constants";
import { dbError } from "@/lib/errors";
import { nichesTag } from "@/lib/niches-cache";
import { STAGE_COLORS } from "@/lib/stages";
import { runAction } from "@/server/action-utils";
import { importLeadsSchema, leadCreateSchema, leadUpdateSchema, noteCorrectionSchema, noteSchema } from "@/lib/validation";

const LEAD_ROLES = ["admin", "sales"] as const satisfies ("admin" | "sales")[];

export async function createLead(input: unknown) {
  return runAction([...LEAD_ROLES], leadCreateSchema, input, async (d, { supabase, profile }) => {
    const { data, error } = await supabase.rpc("create_lead", {
      p_name: d.name,
      p_company_name: d.companyName,
      p_phone: d.phone.display,
      p_phone_normalized: d.phone.e164,
      p_email: d.email,
      p_niche_id: d.niche.id,
      p_new_niche: d.niche.id ? undefined : d.niche.newName,
      p_stage_id: d.stageId,
      // Ignored by the database for Sales; validated as an active sales user for Admin.
      p_owner_id: profile.role === "admin" ? d.ownerId : undefined,
      p_note: d.note,
      p_follow_up_at: d.followUpAt,
      p_follow_up_task: d.followUpTask,
      p_allow_duplicate: d.allowDuplicate,
    });
    if (error) return dbError(error);
    if (!d.niche.id) updateTag(nichesTag(profile.company.id));
    return { ok: true, data: { id: data } };
  });
}

/**
 * Excel import: creates up to 500 leads in one call. Each row gets the same rules, timeline and
 * permissions as adding one lead; a bad row is reported and the rest still go in. The database
 * sends one summary alert per person instead of one per lead.
 */
export async function importLeads(input: unknown) {
  return runAction([...LEAD_ROLES], importLeadsSchema, input, async (d, { supabase, profile }) => {
    const { data, error } = await supabase.rpc("import_leads", {
      p_rows: d.rows.map((r) => ({
        name: r.name, phone: r.phone.display, phone_normalized: r.phone.e164, email: r.email, company_name: r.companyName,
        niche_id: r.niche.id, new_niche: r.niche.id ? undefined : r.niche.newName, stage_id: r.stageId,
        // Ignored by the database for Sales, as when adding one lead.
        owner_id: profile.role === "admin" ? r.ownerId : undefined, note: r.note,
      })),
      p_allow_duplicates: d.allowDuplicates,
    });
    if (error) return dbError(error);
    if (d.rows.some((r) => !r.niche.id)) updateTag(nichesTag(profile.company.id));
    return { ok: true, data: data as unknown as { index: number; id?: string; error?: string }[] };
  });
}

export async function updateLead(input: unknown) {
  return runAction([...LEAD_ROLES], leadUpdateSchema, input, async (d, { supabase, profile }) => {
    const { data, error } = await supabase.rpc("update_lead", {
      p_id: d.id,
      p_version: d.version,
      p_name: d.name,
      // Always sent: an empty field clears the company.
      p_company_name: d.companyName ?? "",
      p_phone: d.phone.display,
      p_phone_normalized: d.phone.e164,
      p_email: d.email,
      p_niche_id: d.niche.id,
      p_new_niche: d.niche.id ? undefined : d.niche.newName,
      p_allow_duplicate: d.allowDuplicate,
    });
    if (error) return dbError(error);
    if (!d.niche.id) updateTag(nichesTag(profile.company.id));
    return { ok: true, data: { version: data } };
  });
}

export async function checkDuplicatePhone(input: unknown) {
  return runAction([...LEAD_ROLES], z.object({ phone: z.string().max(40), excludeLeadId: z.uuid().optional() }), input, async (d, { supabase }) => {
    const { normalizePhone } = await import("@/lib/phone");
    const n = normalizePhone(d.phone);
    if (!n) return { ok: true, data: { duplicate: false, visibleLeadId: null as string | null } };
    const { data, error } = await supabase.rpc("check_duplicate_phone", { p_phone_normalized: n.e164, p_exclude_lead_id: d.excludeLeadId });
    if (error) return dbError(error);
    const r = data as { duplicate: boolean; visible_lead_id?: string | null };
    return { ok: true, data: { duplicate: r.duplicate, visibleLeadId: r.visible_lead_id ?? null } };
  });
}

/** Moves a lead to another stage of its company's pipeline (the database checks the stage belongs to it). */
export async function setLeadStage(input: unknown) {
  return runAction([...LEAD_ROLES], z.object({ id: z.uuid(), stageId: z.uuid() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("leads").update({ stage_id: d.stageId }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: undefined };
  });
}

/** Saves the dragged order of a lead's notes (shared by everyone who can see the lead). */
export async function reorderLeadNotes(input: unknown) {
  const schema = z.object({ leadId: z.uuid(), ids: z.array(z.uuid()).max(200) });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_lead_note_order", { p_lead_id: d.leadId, p_ids: d.ids });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Colours one note card on the call screen (null clears it); shared like the order. */
export async function setLeadNoteColor(input: unknown) {
  const schema = z.object({ leadId: z.uuid(), activityId: z.uuid(), color: z.enum(STAGE_COLORS).nullable() });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_lead_note_color", { p_lead_id: d.leadId, p_activity_id: d.activityId, p_color: d.color });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Sets (or clears, with null) how warm a lead is. RLS limits Sales to their own leads. */
export async function setLeadTemperature(input: unknown) {
  return runAction([...LEAD_ROLES], z.object({ id: z.uuid(), temperature: z.enum(LEAD_TEMPERATURES).nullable() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("leads").update({ temperature: d.temperature }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: undefined };
  });
}

export async function assignLead(input: unknown) {
  return runAction(["admin"], z.object({ id: z.uuid(), ownerId: z.uuid() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("leads").update({ owner_id: d.ownerId }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: undefined };
  });
}

export async function setLeadArchived(input: unknown) {
  return runAction(["admin"], z.object({ id: z.uuid(), archived: z.boolean() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase
      .from("leads")
      .update({ archived_at: d.archived ? new Date().toISOString() : null })
      .eq("id", d.id)
      .select("id")
      .maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: undefined };
  });
}

export async function addNote(input: unknown) {
  return runAction([...LEAD_ROLES], noteSchema, input, async (d, { supabase, profile }) => {
    const { error } = await supabase.from("lead_activities").insert({ lead_id: d.leadId, type: "note", body: d.body, actor_id: profile.id });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function correctNote(input: unknown) {
  return runAction([...LEAD_ROLES], noteCorrectionSchema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("correct_note", { p_note_id: d.noteId, p_body: d.body });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}
