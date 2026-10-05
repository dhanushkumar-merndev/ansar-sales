"use client";

// Read queries run in the browser as the signed-in user: RLS decides what is returned.
// Every list is server-filtered, server-paginated and abortable.
import type { ExpenseCategory, LeadStatus, ReminderState } from "@/lib/constants";
import type { Json } from "@/lib/database.types";
import { toPageResult, rangeFor, type PageResult } from "@/lib/pagination";
import { cleanSearch, escapeLike } from "@/lib/search";
import { createClient } from "@/lib/supabase/client";
import { addDays, istDayStartUtc } from "@/lib/time";
import type { FollowUpListItem, LeadListItem, NicheOption, StaffOption, UserListItem } from "@/lib/types";

const sb = () => createClient();

function unwrapPage<T>(data: Json | null, page: number, pageSize: number): PageResult<T> {
  const r = (data ?? { items: [], total: 0 }) as unknown as { items: T[]; total: number };
  return toPageResult(r.items, Number(r.total), page, pageSize);
}

export type LeadQuery = {
  q: string; status: LeadStatus | null; niche: string | null; owner: string | null;
  from: string | null; to: string | null; overdue: boolean; archived: boolean;
  sort: string; dir: "asc" | "desc"; page: number; pageSize: number;
};

export async function fetchLeads(p: LeadQuery, signal: AbortSignal): Promise<PageResult<LeadListItem>> {
  const { data, error } = await sb()
    .rpc("list_leads", {
      p_search: cleanSearch(p.q) || undefined,
      p_statuses: p.status ? [p.status] : undefined,
      p_niche_id: p.niche ?? undefined,
      p_owner_id: p.owner ?? undefined,
      p_created_from: p.from ? istDayStartUtc(p.from) : undefined,
      p_created_to: p.to ? istDayStartUtc(addDays(p.to, 1)) : undefined,
      p_overdue_only: p.overdue,
      p_archived: p.archived,
      p_sort: p.sort,
      p_dir: p.dir,
      p_limit: p.pageSize,
      p_offset: (p.page - 1) * p.pageSize,
    })
    .abortSignal(signal);
  if (error) throw error;
  return unwrapPage<LeadListItem>(data, p.page, p.pageSize);
}

export type FollowUpView = "overdue" | "today" | "upcoming" | "completed" | "cancelled";

export async function fetchFollowUps(
  p: { view: FollowUpView; assignee: string | null; q: string; page: number; pageSize: number },
  signal: AbortSignal,
): Promise<PageResult<FollowUpListItem>> {
  const { data, error } = await sb()
    .rpc("list_follow_ups", {
      p_view: p.view,
      p_assignee_id: p.assignee ?? undefined,
      p_search: cleanSearch(p.q) || undefined,
      p_limit: p.pageSize,
      p_offset: (p.page - 1) * p.pageSize,
    })
    .abortSignal(signal);
  if (error) throw error;
  return unwrapPage<FollowUpListItem>(data, p.page, p.pageSize);
}

export async function fetchLead(id: string, signal: AbortSignal) {
  const { data, error } = await sb()
    .from("leads")
    .select(
      "id, name, phone, phone_normalized, email, status, version, created_at, updated_at, archived_at, owner_id, " +
        "niche:niches!leads_niche_id_fkey(id, name), owner:profiles!leads_owner_id_fkey(id, display_name), creator:profiles!leads_created_by_fkey(display_name)",
    )
    .eq("id", id)
    .abortSignal(signal)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as LeadDetail | null;
}

export type LeadDetail = {
  id: string; name: string; phone: string; phone_normalized: string; email: string | null; status: LeadStatus;
  version: number; created_at: string; updated_at: string; archived_at: string | null; owner_id: string;
  niche: NicheOption; owner: { id: string; display_name: string }; creator: { display_name: string } | null;
};

export type LeadFollowUp = {
  id: string; task: string; due_at: string; state: "pending" | "completed" | "cancelled"; revision: number;
  assignee: { display_name: string } | null;
  reminder_deliveries: { revision: number; state: ReminderState; attempts: number; last_error: string | null; sent_at: string | null }[];
};

/** Pending follow-ups for one lead (bounded). */
export async function fetchLeadFollowUps(leadId: string, signal: AbortSignal) {
  const { data, error } = await sb()
    .from("follow_ups")
    .select("id, task, due_at, state, revision, assignee:profiles!follow_ups_assignee_id_fkey(display_name), reminder_deliveries(revision, state, attempts, last_error, sent_at)")
    .eq("lead_id", leadId)
    .eq("state", "pending")
    .order("due_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(20)
    .abortSignal(signal);
  if (error) throw error;
  return data as unknown as LeadFollowUp[];
}

export type Activity = {
  id: string; type: string; body: string | null; meta: Record<string, unknown>; created_at: string; edited_at: string | null;
  follow_up_id: string | null; actor_id: string | null; actor: { display_name: string } | null;
};

/** Newest-first timeline; fetches one extra row to know whether more exist (no count needed). */
export async function fetchTimeline(leadId: string, limit: number, signal: AbortSignal) {
  const { data, error } = await sb()
    .from("lead_activities")
    .select("id, type, body, meta, created_at, edited_at, follow_up_id, actor_id, actor:profiles!lead_activities_actor_id_fkey(display_name)")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(0, limit) // inclusive: limit + 1 rows
    .abortSignal(signal);
  if (error) throw error;
  const rows = data as unknown as Activity[];
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function fetchStaff(signal: AbortSignal): Promise<StaffOption[]> {
  const { data, error } = await sb()
    .from("profiles")
    .select("id, display_name, role")
    .eq("is_active", true)
    .in("role", ["sales", "admin"])
    .order("display_name")
    .order("id")
    .limit(100)
    .abortSignal(signal);
  if (error) throw error;
  return data;
}

/** Up to 20 active niches matching the term, plus an exact normalized-match check for the create option. */
export async function searchNiches(term: string, signal: AbortSignal) {
  const norm = cleanSearch(term).toLowerCase();
  const base = () => sb().from("niches").select("id, name").is("archived_at", null);
  const listQ = (norm ? base().ilike("normalized_name", `%${escapeLike(norm)}%`) : base())
    .order("normalized_name")
    .order("id")
    .limit(20)
    .abortSignal(signal);
  const exactQ = norm
    ? sb().from("niches").select("id, name, archived_at, merged_into_id").eq("normalized_name", norm).abortSignal(signal).maybeSingle()
    : Promise.resolve({ data: null, error: null });
  const [list, exact] = await Promise.all([listQ, exactQ]);
  if (list.error) throw list.error;
  if (exact.error) throw exact.error;
  return { options: list.data as NicheOption[], exact: exact.data as (NicheOption & { archived_at: string | null; merged_into_id: string | null }) | null };
}

export async function fetchUsers(p: { q: string; role: string | null; page: number; pageSize: number }, signal: AbortSignal) {
  const { data, error } = await sb()
    .rpc("admin_list_users", {
      p_search: cleanSearch(p.q) || undefined,
      p_role: (p.role as "admin" | "sales" | "account" | null) ?? undefined,
      p_limit: p.pageSize,
      p_offset: (p.page - 1) * p.pageSize,
    })
    .abortSignal(signal);
  if (error) throw error;
  return unwrapPage<UserListItem>(data, p.page, p.pageSize);
}

export type ExpenseRow = {
  id: string; expense_date: string; category: ExpenseCategory; amount: number; description: string | null;
  archived_at: string | null; updated_at: string; author: { display_name: string } | null;
};
export type CapitalRow = {
  id: string; entry_date: string; contributor: string; amount: number; description: string | null;
  archived_at: string | null; updated_at: string; author: { display_name: string } | null;
};

export async function fetchExpenses(
  p: { month: string | null; category: ExpenseCategory | null; archived: boolean; page: number; pageSize: number },
  signal: AbortSignal,
): Promise<PageResult<ExpenseRow>> {
  let q = sb()
    .from("expenses")
    .select("id, expense_date, category, amount, description, archived_at, updated_at, author:profiles!expenses_created_by_fkey(display_name)", { count: "exact" });
  q = p.archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
  if (p.month) q = q.gte("expense_date", `${p.month}-01`).lt("expense_date", nextMonth(p.month));
  if (p.category) q = q.eq("category", p.category);
  const [from, to] = rangeFor(p.page, p.pageSize);
  const { data, error, count } = await q
    .order("expense_date", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to)
    .abortSignal(signal);
  if (error) throw error;
  return toPageResult(data as unknown as ExpenseRow[], count ?? 0, p.page, p.pageSize);
}

export async function fetchCapital(p: { archived: boolean; page: number; pageSize: number }, signal: AbortSignal): Promise<PageResult<CapitalRow>> {
  let q = sb()
    .from("capital_entries")
    .select("id, entry_date, contributor, amount, description, archived_at, updated_at, author:profiles!capital_entries_created_by_fkey(display_name)", { count: "exact" });
  q = p.archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
  const [from, to] = rangeFor(p.page, p.pageSize);
  const { data, error, count } = await q
    .order("entry_date", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to)
    .abortSignal(signal);
  if (error) throw error;
  return toPageResult(data as unknown as CapitalRow[], count ?? 0, p.page, p.pageSize);
}

export type FinanceActivity = { id: string; entity_type: string; action: string; changes: Record<string, { from: unknown; to: unknown }>; created_at: string; actor: { display_name: string } | null };

export async function fetchFinanceHistory(entityId: string, signal: AbortSignal) {
  const { data, error } = await sb()
    .from("finance_activities")
    .select("id, entity_type, action, changes, created_at, actor:profiles!finance_activities_actor_id_fkey(display_name)")
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(50)
    .abortSignal(signal);
  if (error) throw error;
  return data as unknown as FinanceActivity[];
}

export function nextMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export async function fetchTelegramStatus(signal: AbortSignal) {
  const { data, error } = await sb()
    .from("telegram_connections")
    .select("status, telegram_username, last_error, connected_at")
    .abortSignal(signal)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function fetchDashboard<T>(fn: "dashboard_admin" | "dashboard_sales" | "dashboard_finance", arg: number, signal: AbortSignal): Promise<T> {
  const client = sb();
  const req = fn === "dashboard_finance" ? client.rpc(fn, { p_months: arg }) : client.rpc(fn, { p_days: arg });
  const { data, error } = await req.abortSignal(signal);
  if (error) throw error;
  return data as unknown as T;
}

export type NicheAdminRow = { id: string; name: string; archived_at: string | null; merged_into_id: string | null; created_at: string; leads: { count: number }[] };

export async function fetchNicheAdmin(p: { q: string; archived: boolean; page: number; pageSize: number }, signal: AbortSignal): Promise<PageResult<NicheAdminRow>> {
  let q = sb().from("niches").select("id, name, archived_at, merged_into_id, created_at, leads(count)", { count: "exact" });
  q = p.archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
  const term = cleanSearch(p.q).toLowerCase();
  if (term) q = q.ilike("normalized_name", `%${escapeLike(term)}%`);
  const [from, to] = rangeFor(p.page, p.pageSize);
  const { data, error, count } = await q.order("normalized_name").order("id").range(from, to).abortSignal(signal);
  if (error) throw error;
  return toPageResult(data as unknown as NicheAdminRow[], count ?? 0, p.page, p.pageSize);
}
