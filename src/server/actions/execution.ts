"use server";

import { z } from "zod";
import type { AppRole } from "@/lib/constants";
import type { Json } from "@/lib/database.types";
import { dbError } from "@/lib/errors";
import { boqExecutedSchema, boqItemSchema, boqRevisionSchema, boqStatusSchema, siteLogSchema, snagSchema } from "@/lib/project-validation";
import { runAction } from "@/server/action-utils";

// The database decides per project who may edit BOQs (manager, designers), progress (execution), logs and snags.
const TEAM: AppRole[] = ["admin", "architect_manager", "landscape_designer", "execution"];
const changed = () => dbError({ message: "project_changed" });

export async function createBoqRevision(input: unknown) {
  return runAction(TEAM, boqRevisionSchema, input, async (d, { supabase }) => {
    if (d.copyFrom) {
      const { data, error } = await supabase.rpc("copy_boq_revision", { p_revision_id: d.copyFrom, p_label: d.label });
      if (error) return dbError(error);
      return { ok: true, data: { id: data as string } };
    }
    const { data, error } = await supabase.from("project_boq_revisions").insert({ project_id: d.projectId, label: d.label, title: d.title ?? null }).select("id").single();
    if (error) return dbError(error);
    return { ok: true, data: { id: data.id } };
  });
}

export async function setBoqStatus(input: unknown) {
  return runAction(["admin", "architect_manager"], boqStatusSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_boq_revisions").update({ status: d.status }).eq("id", d.id).eq("version", d.version).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return changed();
    return { ok: true, data: undefined };
  });
}

export async function archiveBoqRevision(input: unknown) {
  return runAction(["admin", "architect_manager", "landscape_designer"], z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_boq_revisions").update({ archived_at: new Date().toISOString() }).eq("id", d.id).eq("status", "draft").select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return { ok: false, error: "Only a draft can be removed." };
    return { ok: true, data: undefined };
  });
}

export async function saveBoqItem(input: unknown) {
  return runAction(TEAM, boqItemSchema, input, async (d, { supabase }) => {
    const row = { section: d.section, item: d.item, description: d.description ?? null, unit: d.unit, qty: d.qty, rate: d.rate };
    if (d.id) {
      const { data, error } = await supabase.from("project_boq_items").update(row).eq("id", d.id).select("id").maybeSingle();
      if (error) return dbError(error);
      if (!data) return dbError({ message: "forbidden" });
      return { ok: true, data: { id: data.id } };
    }
    const { data: last } = await supabase.from("project_boq_items").select("position").eq("revision_id", d.revisionId)
      .is("archived_at", null).order("position", { ascending: false }).limit(1).maybeSingle();
    const { data, error } = await supabase.from("project_boq_items").insert({ ...row, revision_id: d.revisionId, position: (last?.position ?? 0) + 1 }).select("id").single();
    if (error) return dbError(error);
    return { ok: true, data: { id: data.id } };
  });
}

export async function archiveBoqItem(input: unknown) {
  return runAction(TEAM, z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_boq_items").update({ archived_at: new Date().toISOString() }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "forbidden" });
    return { ok: true, data: undefined };
  });
}

export async function setBoqExecuted(input: unknown) {
  return runAction(TEAM, boqExecutedSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_boq_items").update({ executed_qty: d.executedQty }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "forbidden" });
    return { ok: true, data: undefined };
  });
}

export async function saveSiteLog(input: unknown) {
  return runAction(TEAM, siteLogSchema, input, async (d, { supabase }) => {
    const row = { work_done: d.workDone as Json, workers: d.workers, issues: d.issues ?? null };
    if (d.id) {
      const { data, error } = await supabase.from("project_site_logs").update(row).eq("id", d.id).eq("version", d.version ?? 0).select("id").maybeSingle();
      if (error) return dbError(error);
      if (!data) return changed();
      return { ok: true, data: undefined };
    }
    const { error } = await supabase.from("project_site_logs").insert({ ...row, project_id: d.projectId, log_date: d.logDate });
    if (error) {
      if (error.code === "23505") return { ok: false, error: "You already logged this day. Open it to add more." };
      return dbError(error);
    }
    return { ok: true, data: undefined };
  });
}

export async function saveSnag(input: unknown) {
  return runAction(TEAM, snagSchema, input, async (d, { supabase }) => {
    const row = { title: d.title, details: d.details ?? null, owner_id: d.ownerId, due_date: d.dueDate, ...(d.status ? { status: d.status } : {}) };
    if (d.id) {
      const { data, error } = await supabase.from("project_snags").update(row).eq("id", d.id).eq("version", d.version ?? 0).select("id").maybeSingle();
      if (error) return dbError(error);
      if (!data) return changed();
      return { ok: true, data: undefined };
    }
    const { error } = await supabase.from("project_snags").insert({ project_id: d.projectId, title: d.title, details: d.details ?? null, owner_id: d.ownerId, due_date: d.dueDate });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function setSnagStatus(input: unknown) {
  return runAction(TEAM, z.object({ id: z.uuid(), version: z.number().int().positive(), status: z.enum(["open", "fixed", "verified"]) }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_snags").update({ status: d.status }).eq("id", d.id).eq("version", d.version).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return changed();
    return { ok: true, data: undefined };
  });
}
