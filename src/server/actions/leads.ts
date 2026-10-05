"use server";

import { updateTag } from "next/cache";
import { z } from "zod";
import { LEAD_STATUSES } from "@/lib/constants";
import { dbError } from "@/lib/errors";
import { NICHES_TAG } from "@/lib/niches-cache";
import { runAction } from "@/server/action-utils";
import { leadCreateSchema, leadUpdateSchema, noteCorrectionSchema, noteSchema } from "@/lib/validation";

const LEAD_ROLES = ["admin", "sales"] as const satisfies ("admin" | "sales")[];

export async function createLead(input: unknown) {
  return runAction([...LEAD_ROLES], leadCreateSchema, input, async (d, { supabase, profile }) => {
    const { data, error } = await supabase.rpc("create_lead", {
      p_name: d.name,
      p_phone: d.phone.display,
      p_phone_normalized: d.phone.e164,
      p_email: d.email,
      p_niche_id: d.niche.id,
      p_new_niche: d.niche.id ? undefined : d.niche.newName,
      p_status: d.status,
      // Ignored by the database for Sales; validated as an active sales user for Admin.
      p_owner_id: profile.role === "admin" ? d.ownerId : undefined,
      p_note: d.note,
      p_follow_up_at: d.followUpAt,
      p_follow_up_task: d.followUpTask,
      p_allow_duplicate: d.allowDuplicate,
    });
    if (error) return dbError(error);
    if (!d.niche.id) updateTag(NICHES_TAG);
    return { ok: true, data: { id: data } };
  });
}

export async function updateLead(input: unknown) {
  return runAction([...LEAD_ROLES], leadUpdateSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("update_lead", {
      p_id: d.id,
      p_version: d.version,
      p_name: d.name,
      p_phone: d.phone.display,
      p_phone_normalized: d.phone.e164,
      p_email: d.email,
      p_niche_id: d.niche.id,
      p_new_niche: d.niche.id ? undefined : d.niche.newName,
      p_allow_duplicate: d.allowDuplicate,
    });
    if (error) return dbError(error);
    if (!d.niche.id) updateTag(NICHES_TAG);
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

export async function setLeadStatus(input: unknown) {
  return runAction([...LEAD_ROLES], z.object({ id: z.uuid(), status: z.enum(LEAD_STATUSES) }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("leads").update({ status: d.status }).eq("id", d.id).select("id").maybeSingle();
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
