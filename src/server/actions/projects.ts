"use server";

import type { AppRole } from "@/lib/constants";
import type { Json, TablesUpdate } from "@/lib/database.types";
import { dbError } from "@/lib/errors";
import {
  handoffSchema, phaseChecklistSchema, phaseItemOrderSchema, phaseItemSchema, phaseItemUpdateSchema, phasePatchSchema, phaseProgressSchema, phaseQuickAddSchema,
  phaseSaveSchema, projectCreateSchema, projectFinancialsSchema, projectMemberSchema, projectNoteSchema, projectUpdateSchema, reorderSchema,
  stageRenameSchema,
} from "@/lib/project-validation";
import { formatINR } from "@/lib/format";
import { PROJECT_COLORS, scheduleExcess, scheduleExcessMessage, sumAmounts } from "@/lib/projects";
import { addDays } from "@/lib/time";
import { runAction } from "@/server/action-utils";

/** Everyone who works on projects; the database decides per project what each may change. */
const PROJECT_ROLES: AppRole[] = ["admin", "architect_manager", "landscape_designer", "execution", "account"];
const changed = () => dbError({ message: "project_changed" });

/** BDM (own lead) or admin: hand an interested lead over to the admins to start a project. */
export async function handoffLead(input: unknown) {
  return runAction(["admin", "sales"], handoffSchema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("handoff_lead", { p_lead_id: d.leadId, p_note: d.note });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Admin: one transaction creates the project, its team, timeline, and closes the lead. */
export async function createProject(input: unknown) {
  return runAction(["admin"], projectCreateSchema, input, async (d, { supabase }) => {
    const scheduled = sumAmounts(d.milestones.map((m) => m.amount));
    if (scheduleExcess(d.contractValue, scheduled)) return { ok: false, error: scheduleExcessMessage(scheduled, d.contractValue), code: "schedule_over_value" };
    const members = [
      ...(d.architectManagerId ? [{ user_id: d.architectManagerId, role: "architect_manager" }] : []),
      ...d.designerIds.map((id) => ({ user_id: id, role: "landscape_designer" })),
      ...d.executionIds.map((id) => ({ user_id: id, role: "execution" })),
    ];
    const { data, error } = await supabase.rpc("create_project", {
      p_name: d.name,
      p_client_name: d.clientName,
      p_start: d.startDate,
      p_end: d.endDate,
      p_lead_id: d.leadId,
      p_client_phone: d.clientPhone,
      p_client_email: d.clientEmail,
      p_site_address: d.siteAddress,
      p_color: d.color,
      p_area_sqft: d.areaSqft as unknown as number,
      p_rate_per_sqft: d.ratePerSqft as unknown as number,
      p_contract_value: d.contractValue as unknown as number,
      p_members: members as unknown as Json,
      p_phases: d.phases as unknown as Json,
      p_mark_won: d.markWon,
      p_milestones: d.milestones as unknown as Json,
    });
    if (error) return dbError(error);
    return { ok: true, data: { id: data } };
  });
}

export async function updateProject(input: unknown) {
  return runAction(PROJECT_ROLES, projectUpdateSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("projects").update({
      name: d.name, client_name: d.clientName, client_phone: d.clientPhone ?? null, client_email: d.clientEmail ?? null,
      site_address: d.siteAddress ?? null, start_date: d.startDate, end_date: d.endDate, status: d.status, color: d.color,
    }).eq("id", d.id).eq("version", d.version).select("version").maybeSingle();
    if (error) return dbError(error);
    if (!data) return changed();
    return { ok: true, data: { version: data.version } };
  });
}

/** Admin or the project's architect manager: the project's colour (folders, Gantt, timeline). */
export async function setProjectColor(input: unknown) {
  const { z } = await import("zod");
  return runAction(["admin", "architect_manager"], z.object({ id: z.uuid(), color: z.enum(PROJECT_COLORS) }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("projects").update({ color: d.color }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "forbidden" });
    return { ok: true, data: undefined };
  });
}

/** Admin or architect manager: a year or month folder's colour on the Projects page, for the whole company (null resets it). */
export async function setProjectFolderColor(input: unknown) {
  const { z } = await import("zod");
  const schema = z.object({ year: z.number().int().min(2000).max(2200), month: z.number().int().min(1).max(12).nullable(), color: z.enum(PROJECT_COLORS).nullable() });
  return runAction(["admin", "architect_manager"], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_project_folder_color", { p_year: d.year, p_month: d.month as number, p_color: d.color as string });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function setProjectSitePin(input: unknown) {
  const { z } = await import("zod");
  const schema = z.object({ id: z.uuid(), lat: z.number().min(-90).max(90).nullable(), lng: z.number().min(-180).max(180).nullable() });
  return runAction(PROJECT_ROLES, schema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("projects").update({ site_lat: d.lat, site_lng: d.lng }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "forbidden" });
    return { ok: true, data: undefined };
  });
}

export async function setProjectFinancials(input: unknown) {
  return runAction(["admin", "account"], projectFinancialsSchema, input, async (d, { supabase }) => {
    // The value can't drop below what the payment schedule already asks for.
    const { data: parts, error: pe } = await supabase.from("project_payment_milestones").select("amount").eq("project_id", d.projectId).is("archived_at", null);
    if (pe) return dbError(pe);
    const scheduled = sumAmounts((parts ?? []).map((m) => m.amount));
    if (scheduleExcess(d.contractValue, scheduled)) {
      return {
        ok: false, code: "schedule_over_value", fieldErrors: { contractValue: [`At least ${formatINR(scheduled)}`] },
        error: `The payment parts add up to ${formatINR(scheduled)}, more than ${formatINR(Number(d.contractValue))}. Lower or remove parts first, or keep the value at least ${formatINR(scheduled)}.`,
      };
    }
    const { error } = await supabase.rpc("set_project_financials", {
      p_project_id: d.projectId,
      p_area_sqft: (d.areaSqft ?? null) as unknown as number,
      p_rate_per_sqft: (d.ratePerSqft ?? null) as unknown as number,
      p_contract_value: (d.contractValue ?? null) as unknown as number,
    });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function setProjectMember(input: unknown) {
  return runAction(["admin", "architect_manager"], projectMemberSchema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_project_member", { p_project_id: d.projectId, p_user_id: d.userId, p_role: d.role, p_on: d.on });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function addProjectNote(input: unknown) {
  return runAction(PROJECT_ROLES, projectNoteSchema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("add_project_note", { p_project_id: d.projectId, p_body: d.body });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Managers add or fully edit a phase; with a version it is an edit that fails on a conflict. */
export async function savePhase(input: unknown) {
  return runAction(["admin", "architect_manager"], phaseSaveSchema, input, async (d, { supabase }) => {
    const row = {
      category: d.category, name: d.name, color: d.color, owner_id: d.ownerId, planned_start: d.plannedStart, deadline: d.deadline,
      actual_start: d.actualStart, submitted_on: d.submittedOn, status: d.status, needs_client_approval: d.needsClientApproval,
      remark: d.remark ?? null,
      ...(d.notes !== undefined ? { notes: d.notes as Json } : {}),
    };
    if (!d.id) {
      const { data: last } = await supabase.from("project_phases").select("position").eq("project_id", d.projectId)
        .is("archived_at", null).order("position", { ascending: false }).limit(1).maybeSingle();
      const { data, error } = await supabase.from("project_phases")
        .insert({ ...row, project_id: d.projectId, position: (last?.position ?? 0) + 1 }).select("id, version").single();
      if (error) return dbError(error);
      return { ok: true, data: { id: data.id, version: data.version } };
    }
    const { data, error } = await supabase.from("project_phases").update(row)
      .eq("id", d.id).eq("version", d.version ?? 0).is("archived_at", null).select("id, version").maybeSingle();
    if (error) return dbError(error);
    if (!data) return changed();
    return { ok: true, data: { id: data.id, version: data.version } };
  });
}

/** Phase owner or manager: status, actual dates, remark and notes. */
export async function updatePhaseProgress(input: unknown) {
  return runAction(PROJECT_ROLES, phaseProgressSchema, input, async (d, { supabase }) => {
    const patch: TablesUpdate<"project_phases"> = {};
    if (d.status !== undefined) patch.status = d.status;
    if (d.actualStart !== undefined) patch.actual_start = d.actualStart;
    if (d.submittedOn !== undefined) patch.submitted_on = d.submittedOn;
    if (d.remark !== undefined) patch.remark = d.remark ?? null;
    if (d.notes !== undefined) patch.notes = d.notes as Json;
    const { data, error } = await supabase.from("project_phases").update(patch)
      .eq("id", d.id).eq("version", d.version).is("archived_at", null).select("version").maybeSingle();
    if (error) return dbError(error);
    if (!data) return changed();
    return { ok: true, data: { version: data.version } };
  });
}

/** Edits one cell of the timeline sheet. Owners may change the progress fields only (the database enforces it). */
export async function patchPhase(input: unknown) {
  return runAction(PROJECT_ROLES, phasePatchSchema, input, async (d, { supabase }) => {
    const patch: TablesUpdate<"project_phases"> = {};
    if (d.name !== undefined) patch.name = d.name;
    if (d.category !== undefined) patch.category = d.category;
    if (d.ownerId !== undefined) patch.owner_id = d.ownerId;
    if (d.plannedStart !== undefined) patch.planned_start = d.plannedStart;
    if (d.deadline !== undefined) patch.deadline = d.deadline;
    if (d.submittedOn !== undefined) patch.submitted_on = d.submittedOn;
    if (d.remark !== undefined) patch.remark = d.remark || null;
    const { data, error } = await supabase.from("project_phases").update(patch)
      .eq("id", d.id).eq("version", d.version).is("archived_at", null).select("version").maybeSingle();
    if (error) return dbError(error);
    if (!data) return changed();
    return { ok: true, data: { version: data.version } };
  });
}

/**
 * Managers: a phase typed into the sheet, with its steps. It goes right after `afterId` (the last phase of
 * its stage) and starts the day after that one's deadline, inside the project's dates (or on the dates picked
 * in the Gantt's Add dialog).
 */
export async function addPhaseQuick(input: unknown) {
  return runAction(["admin", "architect_manager"], phaseQuickAddSchema, input, async (d, { supabase }) => {
    const [{ data: project, error: pe }, { data: phases, error: le }] = await Promise.all([
      supabase.from("projects").select("start_date, end_date").eq("id", d.projectId).maybeSingle(),
      supabase.from("project_phases").select("id, deadline, color, category").eq("project_id", d.projectId).is("archived_at", null)
        .order("position").order("id"),
    ]);
    if (pe || le) return dbError((pe ?? le)!);
    if (!project || !phases) return dbError({ message: "not_found" });
    const after = d.afterId ? phases.find((p) => p.id === d.afterId) : phases.at(-1);
    const sameStage = phases.findLast((p) => p.category === d.category);
    let start = d.plannedStart ?? (after ? addDays(after.deadline, 1) : project.start_date);
    if (!d.plannedStart && start > project.end_date) start = project.end_date;
    if (!d.plannedStart && start < project.start_date) start = project.start_date;
    const { data, error } = await supabase.from("project_phases").insert({
      project_id: d.projectId, category: d.category, name: d.name, color: (sameStage ?? after)?.color ?? "emerald",
      planned_start: start, deadline: d.deadline && d.deadline >= start ? d.deadline : start, position: phases.length + 1,
    }).select("id, version").single();
    if (error) return dbError(error);
    const order = phases.map((p) => p.id);
    order.splice(after ? order.indexOf(after.id) + 1 : order.length, 0, data.id);
    const { error: re } = await supabase.rpc("reorder_project_phases", { p_project_id: d.projectId, p_ids: order });
    if (re) return dbError(re);
    if (d.items.length) {
      const { error: ie } = await supabase.from("project_phase_items")
        .insert(d.items.map((title, n) => ({ phase_id: data.id, title, position: n + 1 })));
      if (ie) return dbError(ie);
    }
    return { ok: true, data: { id: data.id } };
  });
}

/** Managers: renames a stage (every phase in it). */
export async function renameStage(input: unknown) {
  return runAction(["admin", "architect_manager"], stageRenameSchema, input, async (d, { supabase }) => {
    if (d.from === d.to) return { ok: true, data: undefined };
    const { data, error } = await supabase.from("project_phases").update({ category: d.to })
      .eq("project_id", d.projectId).eq("category", d.from).is("archived_at", null).select("id");
    if (error) return dbError(error);
    if (!data?.length) return changed();
    return { ok: true, data: undefined };
  });
}

/** Reorders a phase's steps (manager or the phase owner). */
export async function reorderPhaseItems(input: unknown) {
  return runAction(PROJECT_ROLES, phaseItemOrderSchema, input, async (d, { supabase }) => {
    for (const [n, id] of d.ids.entries()) {
      const { error } = await supabase.from("project_phase_items").update({ position: n + 1 }).eq("id", id).eq("phase_id", d.phaseId);
      if (error) return dbError(error);
    }
    return { ok: true, data: undefined };
  });
}

export async function archivePhase(input: unknown) {
  const { z } = await import("zod");
  return runAction(["admin", "architect_manager"], z.object({ id: z.uuid(), restore: z.boolean().default(false) }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_phases").update({ archived_at: d.restore ? null : new Date().toISOString() })
      .eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: undefined };
  });
}

export async function reorderPhases(input: unknown) {
  return runAction(["admin", "architect_manager"], reorderSchema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("reorder_project_phases", { p_project_id: d.projectId, p_ids: d.ids });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function addPhaseItem(input: unknown) {
  return runAction(PROJECT_ROLES, phaseItemSchema, input, async (d, { supabase }) => {
    const { data: last } = await supabase.from("project_phase_items").select("position").eq("phase_id", d.phaseId)
      .is("archived_at", null).order("position", { ascending: false }).limit(1).maybeSingle();
    const { data, error } = await supabase.from("project_phase_items")
      .insert({ phase_id: d.phaseId, title: d.title, position: (last?.position ?? 0) + 1 }).select("id").single();
    if (error) return dbError(error);
    return { ok: true, data: { id: data.id } };
  });
}

/** The drawer's checklist changes in one go: new steps (after the existing ones), ticks, removals. */
export async function savePhaseChecklist(input: unknown) {
  return runAction(PROJECT_ROLES, phaseChecklistSchema, input, async (d, { supabase }) => {
    const now = new Date().toISOString();
    for (const id of d.remove) {
      const { error } = await supabase.from("project_phase_items").update({ archived_at: now }).eq("id", id).eq("phase_id", d.phaseId);
      if (error) return dbError(error);
    }
    for (const c of d.change) {
      const { error } = await supabase.from("project_phase_items").update({ done_at: c.done ? now : null }).eq("id", c.id).eq("phase_id", d.phaseId);
      if (error) return dbError(error);
    }
    if (d.add.length) {
      const { data: last } = await supabase.from("project_phase_items").select("position").eq("phase_id", d.phaseId)
        .is("archived_at", null).order("position", { ascending: false }).limit(1).maybeSingle();
      const base = last?.position ?? 0;
      const { error } = await supabase.from("project_phase_items")
        .insert(d.add.map((a, n) => ({ phase_id: d.phaseId, title: a.title, position: base + n + 1, done_at: a.done ? now : null })));
      if (error) return dbError(error);
    }
    return { ok: true, data: undefined };
  });
}

export async function updatePhaseItem(input: unknown) {
  return runAction(PROJECT_ROLES, phaseItemUpdateSchema, input, async (d, { supabase }) => {
    const patch: TablesUpdate<"project_phase_items"> = {};
    if (d.title !== undefined) patch.title = d.title;
    if (d.done !== undefined) patch.done_at = d.done ? new Date().toISOString() : null;
    if (d.archived !== undefined) patch.archived_at = d.archived ? new Date().toISOString() : null;
    const { data, error } = await supabase.from("project_phase_items").update(patch).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "forbidden" });
    return { ok: true, data: undefined };
  });
}
