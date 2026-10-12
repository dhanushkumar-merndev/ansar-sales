"use client";

// Project reads run in the browser as the signed-in user; RLS and the definer RPCs decide what
// each person sees (team members: their projects; money: admin and account only).
import type { Json } from "@/lib/database.types";
import { toPageResult, type PageResult } from "@/lib/pagination";
import type {
  ArchivedProjectFolder, BoqRevision, HandoffLead, MyWork, PaymentDue, PaymentStatus, PhaseEvent, ProjectActivity, ProjectDetail, ProjectFileDetail, ProjectFileItem, ProjectFolder,
  ProjectColor, ProjectListItem, ProjectMonth, SiteLog, SiteVisit, Snag, TeamWork,
} from "@/lib/projects";
import { countMonths, monthRange } from "@/lib/projects";
import { readPhaseHistory } from "@/lib/phase-history";
import { cleanSearch } from "@/lib/search";
import type { StageColor } from "@/lib/stages";
import { createClient } from "@/lib/supabase/client";

const sb = () => createClient();

export type ProjectQuery = {
  q: string; status: "open" | "active" | "on_hold" | "completed" | "cancelled" | "all"; member: string | null;
  late: boolean; sort: "end_date" | "created" | "code" | "name"; page: number; pageSize: number;
};

export async function fetchProjects(p: ProjectQuery, signal: AbortSignal): Promise<PageResult<ProjectListItem>> {
  const { data, error } = await sb().rpc("list_projects", {
    p_search: cleanSearch(p.q) || undefined,
    p_status: p.status,
    p_member_id: p.member ?? undefined,
    p_late_only: p.late,
    p_sort: p.sort,
    p_limit: p.pageSize,
    p_offset: (p.page - 1) * p.pageSize,
  }).abortSignal(signal);
  if (error) throw error;
  const r = (data ?? { items: [], total: 0 }) as unknown as { items: ProjectListItem[]; total: number };
  return toPageResult(r.items, Number(r.total), p.page, p.pageSize);
}

const OPEN_STATUSES = ["active", "on_hold"] as const;
/** RPC or parameter not in the database yet (a migration that isn't applied). */
const missing = (e: { code?: string } | null) => e?.code === "PGRST202";

/**
 * Month folders (projects by start date) for the projects page. Until migration 20261008001500 is applied
 * it counts from the projects' start dates instead (bounded; no late counts then: `partial`).
 */
export async function fetchProjectMonths(p: Pick<ProjectQuery, "status" | "late">, signal: AbortSignal): Promise<{ months: ProjectMonth[]; partial: boolean }> {
  const { data, error } = await sb().rpc("project_months", { p_status: p.status, p_late_only: p.late }).abortSignal(signal);
  if (!error) return { months: (data ?? []) as unknown as ProjectMonth[], partial: false };
  if (!missing(error)) throw error;
  let q = sb().from("projects").select("start_date, status, color").is("archived_at", null);
  if (p.status === "open") q = q.in("status", [...OPEN_STATUSES]);
  else if (p.status !== "all") q = q.eq("status", p.status);
  const rows = await q.order("start_date", { ascending: false }).limit(2000).abortSignal(signal);
  if (rows.error) throw rows.error;
  return { months: countMonths(rows.data ?? []), partial: true };
}

/** The projects of one month folder, paged on the server (same fallback as fetchProjectMonths). */
export async function fetchMonthProjects(p: Pick<ProjectQuery, "status" | "late" | "page" | "pageSize"> & { year: number; month: number }, signal: AbortSignal)
  : Promise<PageResult<ProjectListItem> & { partial: boolean }> {
  const { from, to } = monthRange(p.year, p.month);
  const offset = (p.page - 1) * p.pageSize;
  const { data, error } = await sb().rpc("list_projects", {
    p_status: p.status, p_late_only: p.late, p_sort: "start", p_limit: p.pageSize, p_offset: offset, p_from: from, p_to: to,
  }).abortSignal(signal);
  if (!error) {
    const r = (data ?? { items: [], total: 0 }) as unknown as { items: ProjectListItem[]; total: number };
    return { ...toPageResult(r.items, Number(r.total), p.page, p.pageSize), partial: false };
  }
  if (!missing(error)) throw error;
  let q = sb().from("projects").select("id, code, name, client_name, client_phone, status, color, start_date, end_date, lead_id, site_address, updated_at", { count: "exact" })
    .is("archived_at", null).gte("start_date", from).lt("start_date", to);
  if (p.status === "open") q = q.in("status", [...OPEN_STATUSES]);
  else if (p.status !== "all") q = q.eq("status", p.status);
  const rows = await q.order("start_date").order("id").range(offset, offset + p.pageSize - 1).abortSignal(signal);
  if (rows.error) throw rows.error;
  const items = (rows.data ?? []).map((r) => ({ ...r, phases_total: 0, phases_done: 0, late_phases: 0, max_late_days: 0, current_phase: null, team: [] })) as unknown as ProjectListItem[];
  return { ...toPageResult(items, rows.count ?? items.length, p.page, p.pageSize), partial: true };
}

export type FolderColor = { year: number; month: number | null; color: ProjectColor };

/** Shared year/month folder colours of the company; none (defaults) until migration 20261008001600 is applied. */
export async function fetchFolderColors(signal: AbortSignal): Promise<FolderColor[]> {
  const { data, error } = await sb().from("project_folder_colors").select("year, month, color").limit(500).abortSignal(signal);
  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") return [];
    throw error;
  }
  return (data ?? []) as FolderColor[];
}

/** The team-work page: people on the manager's projects (admins: all), over the last `days` days. */
export async function fetchTeamWork(days: number, signal: AbortSignal): Promise<TeamWork> {
  const { data, error } = await sb().rpc("team_work", { p_days: days }).abortSignal(signal);
  if (error) throw error;
  return data as unknown as TeamWork;
}

export async function fetchProjectDetail(id: string, signal: AbortSignal): Promise<ProjectDetail> {
  const { data, error } = await sb().rpc("project_detail", { p_project_id: id }).abortSignal(signal);
  if (error) throw error;
  return data as unknown as ProjectDetail;
}

export async function fetchProjectActivities(id: string, limit: number, signal: AbortSignal) {
  const { data, error } = await sb().rpc("list_project_activities", { p_project_id: id, p_limit: limit }).abortSignal(signal);
  if (error) throw error;
  return data as unknown as { items: ProjectActivity[]; has_more: boolean };
}

export async function fetchHandoffLeads(signal: AbortSignal): Promise<HandoffLead[]> {
  const { data, error } = await sb().rpc("list_handoff_leads", { p_limit: 50 }).abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as unknown as HandoffLead[];
}

export type RolePerson = { id: string; display_name: string };

export async function fetchRolePeople(role: "architect_manager" | "landscape_designer" | "execution", signal: AbortSignal): Promise<RolePerson[]> {
  const { data, error } = await sb().rpc("project_role_people", { p_role: role }).abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as Json as unknown as RolePerson[];
}

export async function fetchPhaseHistory(projectId: string, signal: AbortSignal): Promise<PhaseEvent[]> {
  return readPhaseHistory(sb(), projectId, signal);
}

export async function fetchPaymentStatus(projectId: string, signal: AbortSignal): Promise<PaymentStatus> {
  const { data, error } = await sb().rpc("project_payment_status", { p_project_id: projectId }).abortSignal(signal);
  if (error) throw error;
  return data as unknown as PaymentStatus;
}

export type DueView = "due" | "overdue" | "upcoming" | "paid" | "open";

export async function fetchPaymentDues(p: { view: DueView; q: string; page: number; pageSize: number }, signal: AbortSignal): Promise<PageResult<PaymentDue>> {
  const { data, error } = await sb().rpc("list_payment_dues", {
    p_view: p.view, p_search: cleanSearch(p.q) || undefined, p_limit: p.pageSize, p_offset: (p.page - 1) * p.pageSize,
  }).abortSignal(signal);
  if (error) throw error;
  const r = (data ?? { items: [], total: 0 }) as unknown as { items: PaymentDue[]; total: number };
  return toPageResult(r.items, Number(r.total), p.page, p.pageSize);
}

export type ReceivedPayment = {
  id: string; amount: number; paid_on: string; mode: string; reference: string | null; created_at: string;
  milestone: string | null; received_by: string | null; project: { id: string; name: string; code: string };
};

export async function fetchPaymentsReceived(p: { from: string; to: string; page: number; pageSize: number }, signal: AbortSignal) {
  const { data, error } = await sb().rpc("list_payments_received", {
    p_from: p.from, p_to: p.to, p_limit: p.pageSize, p_offset: (p.page - 1) * p.pageSize,
  }).abortSignal(signal);
  if (error) throw error;
  const r = data as unknown as { items: ReceivedPayment[]; total: number; sum: number; by_mode: Record<string, number> };
  return { ...toPageResult(r.items, Number(r.total), p.page, p.pageSize), sum: Number(r.sum), byMode: r.by_mode };
}

export type PaymentsOverview = {
  collected_month: number; collected_total: number; due_amount: number; due_count: number;
  overdue_amount: number; overdue_count: number; contract_total: number;
};

export async function fetchPaymentsOverview(signal: AbortSignal): Promise<PaymentsOverview> {
  const { data, error } = await sb().rpc("payments_overview").abortSignal(signal);
  if (error) throw error;
  return data as unknown as PaymentsOverview;
}

export type VisitView = "today" | "upcoming" | "past" | "all";

export async function fetchSiteVisits(
  p: { view: VisitView; mine: boolean; projectId?: string; leadId?: string; page: number; pageSize: number }, signal: AbortSignal,
): Promise<PageResult<SiteVisit>> {
  const { data, error } = await sb().rpc("list_site_visits", {
    p_view: p.view, p_mine: p.mine, p_project_id: p.projectId, p_lead_id: p.leadId, p_limit: p.pageSize, p_offset: (p.page - 1) * p.pageSize,
  }).abortSignal(signal);
  if (error) throw error;
  const r = (data ?? { items: [], total: 0 }) as unknown as { items: SiteVisit[]; total: number };
  return toPageResult(r.items, Number(r.total), p.page, p.pageSize);
}

/** The project's "Site images" folder (site visits upload their photos there); null if the user can't see it. */
export async function fetchSiteImagesFolder(projectId: string, signal: AbortSignal): Promise<{ id: string; name: string } | null> {
  const { data, error } = await sb().from("project_folders").select("id, name")
    .eq("project_id", projectId).eq("system_key", "site_images").is("archived_at", null).abortSignal(signal).maybeSingle();
  if (error) throw error;
  return data;
}

export async function fetchVisitPeople(signal: AbortSignal): Promise<(RolePerson & { role: string })[]> {
  const { data, error } = await sb().rpc("site_visit_people").abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as unknown as (RolePerson & { role: string })[];
}

export async function fetchBoq(projectId: string, signal: AbortSignal): Promise<BoqRevision[]> {
  const { data, error } = await sb().rpc("project_boq", { p_project_id: projectId }).abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as unknown as BoqRevision[];
}

export async function fetchSiteLogs(projectId: string, limit: number, signal: AbortSignal): Promise<SiteLog[]> {
  const { data, error } = await sb().from("project_site_logs")
    .select("id, project_id, log_date, work_done, workers, issues, version, created_by, created_at, author:profiles!project_site_logs_created_by_fkey(display_name)")
    .eq("project_id", projectId).is("archived_at", null).order("log_date", { ascending: false }).order("created_at", { ascending: false }).limit(limit)
    .abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as unknown as SiteLog[];
}

export async function fetchSnags(projectId: string, signal: AbortSignal): Promise<Snag[]> {
  const { data, error } = await sb().from("project_snags")
    .select("id, title, details, status, owner_id, due_date, fixed_at, version, created_at, owner:profiles!project_snags_owner_id_fkey(display_name)")
    .eq("project_id", projectId).is("archived_at", null).order("status").order("created_at").limit(200)
    .abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as unknown as Snag[];
}

export async function fetchMyWork(signal: AbortSignal): Promise<MyWork> {
  const { data, error } = await sb().rpc("my_work").abortSignal(signal);
  if (error) throw error;
  return data as unknown as MyWork;
}

export type ProjectsDashboard = {
  cards: {
    active_projects: number; on_hold: number; late_phases: number; late_projects: number; due_this_week: number; handoffs_waiting: number;
    collected_month: number | null; overdue_amount: number | null;
  };
  timeliness: { on_time: number; late_done: number; late_open: number; open_on_track: number };
  by_stage: { name: string; count: number }[];
  team: {
    id: string; name: string; roles: string[]; open_phases: number; late_phases: number;
    projects: { id: string; name: string; role: string; phase: string | null; stage: string | null; status: string | null; late: boolean }[];
    leads: { stage: string; count: number }[] | null;
  }[];
};

export async function fetchProjectsDashboard(signal: AbortSignal): Promise<ProjectsDashboard> {
  const { data, error } = await sb().rpc("projects_dashboard").abortSignal(signal);
  if (error) throw error;
  return data as unknown as ProjectsDashboard;
}

export async function fetchProjectFolders(projectId: string, signal: AbortSignal): Promise<ProjectFolder[]> {
  const { data, error } = await sb().from("project_folders").select("id, parent_id, name, system_key, restricted, position, created_by")
    .eq("project_id", projectId).is("archived_at", null).order("position").order("name").limit(200).abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as ProjectFolder[];
}

/** Admin / architect manager: the project's archived folders (empty until 20261008002000 is applied). */
export async function fetchArchivedFolders(projectId: string, signal: AbortSignal): Promise<ArchivedProjectFolder[]> {
  const { data, error } = await sb().rpc("archived_project_folders", { p_project_id: projectId }).abortSignal(signal);
  if (error) {
    if (error.code === "PGRST202") return [];
    throw error;
  }
  return (data ?? []) as unknown as ArchivedProjectFolder[];
}

export async function fetchFolderFiles(p: { projectId: string; folderId: string | null; q: string; page: number; pageSize: number }, signal: AbortSignal) {
  const { data, error } = await sb().rpc("list_project_folder", {
    p_project_id: p.projectId, p_folder_id: p.folderId ?? undefined, p_search: cleanSearch(p.q) || undefined,
    p_limit: p.pageSize, p_offset: (p.page - 1) * p.pageSize,
  }).abortSignal(signal);
  if (error) throw error;
  const r = (data ?? { items: [], total: 0 }) as unknown as { items: ProjectFileItem[]; total: number };
  return toPageResult(r.items, Number(r.total), p.page, p.pageSize);
}

export async function fetchProjectFile(fileId: string, signal: AbortSignal): Promise<ProjectFileDetail> {
  const { data, error } = await sb().rpc("project_file_detail", { p_file_id: fileId }).abortSignal(signal);
  if (error) throw error;
  const detail = data as unknown as ProjectFileDetail;
  // Pin details the detail RPC doesn't return: drawing coordinates, colour, author (one small extra read;
  // skipped before 20261008002100).
  if (detail.comments.length) {
    const { data: pins, error: pinError } = await sb().from("project_file_comments").select("id, cad_x, cad_y, pin_color, author_id")
      .in("id", detail.comments.slice(0, 500).map((c) => c.id)).abortSignal(signal);
    if (pinError && pinError.code !== "42703") throw pinError;
    const at = new Map((pins ?? []).map((p) => [p.id, p]));
    detail.comments = detail.comments.map((c) => {
      const p = at.get(c.id);
      return { ...c, cad_x: p?.cad_x ?? null, cad_y: p?.cad_y ?? null, pin_color: (p?.pin_color as StageColor | null) ?? null, author_id: p?.author_id ?? null };
    });
  }
  return detail;
}

export async function fetchStorageUsage(projectId: string, signal: AbortSignal) {
  const { data, error } = await sb().rpc("project_storage_usage", { p_project_id: projectId }).abortSignal(signal);
  if (error) throw error;
  return data as unknown as { used: number; quota: number; files: number };
}
