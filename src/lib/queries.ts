"use client";

// Read queries run in the browser as the signed-in user: RLS decides what is returned.
// Every list is server-filtered, server-paginated and abortable.
import type { ExpenseCategory, LeadOutcome, PaymentMode, ReminderState } from "@/lib/constants";
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

/** A page from a list that supports stars, plus how many of the user's items are pinned (max 10). */
export type StarredPageResult<T> = PageResult<T> & { pinnedCount: number };

function unwrapStarredPage<T>(data: Json | null, page: number, pageSize: number): StarredPageResult<T> {
  const pinned = Number((data as { pinned_count?: number } | null)?.pinned_count ?? 0);
  return { ...unwrapPage<T>(data, page, pageSize), pinnedCount: pinned };
}

export type LeadQuery = {
  /** Pipeline stage id. */
  q: string; stage: string | null; niche: string | null; owner: string | null;
  from: string | null; to: string | null; overdue: boolean; archived: boolean; starred: boolean;
  sort: string; dir: "asc" | "desc"; page: number; pageSize: number;
};

export async function fetchLeads(p: LeadQuery, signal: AbortSignal): Promise<StarredPageResult<LeadListItem>> {
  const { data, error } = await sb()
    .rpc("list_leads", {
      p_search: cleanSearch(p.q) || undefined,
      p_stage_ids: p.stage ? [p.stage] : undefined,
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
      p_starred_only: p.starred,
    })
    .abortSignal(signal);
  if (error) throw error;
  return unwrapStarredPage<LeadListItem>(data, p.page, p.pageSize);
}

export type FollowUpView = "overdue" | "today" | "upcoming" | "completed" | "cancelled" | "starred";

export async function fetchFollowUps(
  p: { view: FollowUpView; assignee: string | null; q: string; from?: string | null; to?: string | null; page: number; pageSize: number },
  signal: AbortSignal,
): Promise<StarredPageResult<FollowUpListItem>> {
  const { data, error } = await sb()
    .rpc("list_follow_ups", {
      p_view: p.view,
      p_assignee_id: p.assignee ?? undefined,
      p_search: cleanSearch(p.q) || undefined,
      p_limit: p.pageSize,
      p_offset: (p.page - 1) * p.pageSize,
      p_due_from: p.from ? istDayStartUtc(p.from) : undefined,
      p_due_to: p.to ? istDayStartUtc(addDays(p.to, 1)) : undefined,
    })
    .abortSignal(signal);
  if (error) throw error;
  return unwrapStarredPage<FollowUpListItem>(data, p.page, p.pageSize);
}

export async function fetchLead(id: string, signal: AbortSignal) {
  const { data, error } = await sb()
    .from("leads")
    .select(
      "id, name, phone, phone_normalized, email, status, stage_id, source, source_meta, version, created_at, updated_at, archived_at, owner_id, " +
        "niche:niches!leads_niche_id_fkey(id, name), owner:profiles!leads_owner_id_fkey(id, display_name), creator:profiles!leads_created_by_fkey(display_name), " +
        "stars:lead_stars(pinned_at)", // RLS returns only the signed-in user's own star
    )
    .eq("id", id)
    .abortSignal(signal)
    .maybeSingle();
  if (error) throw error;
  return data as unknown as LeadDetail | null;
}

export type LeadDetail = {
  id: string; name: string; phone: string; phone_normalized: string; email: string | null; status: LeadOutcome; stage_id: string;
  source: "manual" | "facebook"; source_meta: { form_name?: string; ad_name?: string; campaign_name?: string };
  version: number; created_at: string; updated_at: string; archived_at: string | null; owner_id: string;
  niche: NicheOption; owner: { id: string; display_name: string }; creator: { display_name: string } | null;
  stars: { pinned_at: string | null }[];
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
  id: string; expense_date: string; category: ExpenseCategory; category_id: string; amount: number; description: string | null;
  company: { id: string; name: string } | null;
  payment_mode: PaymentMode | null; item: string | null; quantity: number | null;
  recurrence: { active: boolean; next_date: string } | null;
  archived_at: string | null; updated_at: string; author: { display_name: string } | null;
};
export type CapitalRow = {
  id: string; entry_date: string; contributor: string; company: { id: string; name: string } | null; amount: number; payment_mode: PaymentMode | null; item: string | null; quantity: number | null; description: string | null;
  archived_at: string | null; updated_at: string; author: { display_name: string } | null;
};

export type FinanceKind = "expense" | "capital";
export type FinanceSort = "date-desc" | "date-asc" | "amount-desc" | "amount-asc";
export type FinanceEntriesQuery = {
  /** category: a category id; company: a company id of the books (merged books only). */
  kind: FinanceKind; from: string; to: string; q: string; category: string | null; company: string | null; mode: PaymentMode | "unspecified" | null;
  recurring: boolean; archived: boolean; sort: FinanceSort; page: number; pageSize: number;
};

/** One page of expense or capital entries in a date range (typed RPC: escaped search, allowlisted sort). */
export async function fetchFinanceEntries<T extends ExpenseRow | CapitalRow>(p: FinanceEntriesQuery, signal: AbortSignal): Promise<PageResult<T>> {
  const [sort, dir] = p.sort.split("-") as ["date" | "amount", "asc" | "desc"];
  const { data, error } = await sb()
    .rpc("list_finance_entries", {
      p_kind: p.kind,
      p_from: p.from,
      p_to: p.to,
      p_search: cleanSearch(p.q) || undefined,
      p_category_id: p.kind === "expense" ? p.category ?? undefined : undefined,
      p_company_id: p.company ?? undefined,
      p_mode: p.mode ?? undefined,
      p_recurring: p.kind === "expense" && p.recurring,
      p_archived: p.archived,
      p_sort: sort,
      p_dir: dir,
      p_limit: p.pageSize,
      p_offset: (p.page - 1) * p.pageSize,
    })
    .abortSignal(signal);
  if (error) throw error;
  return unwrapPage<T>(data, p.page, p.pageSize);
}

export type YearOverview = {
  year: number;
  months: { month: string; expense: number; expense_entries: number; capital: number; capital_entries: number; categories: Record<ExpenseCategory, number> }[];
  totals: { expense: number; expense_entries: number; capital: number; capital_entries: number };
  previous_december: { expense: number; capital: number };
  years: number[];
};

/** Month totals for the Finance page cards (aggregated in PostgreSQL). */
export async function fetchYearOverview(year: number, signal: AbortSignal): Promise<YearOverview> {
  const { data, error } = await sb().rpc("finance_year_overview", { p_year: year }).abortSignal(signal);
  if (error) throw error;
  return data as unknown as YearOverview;
}

/** The finance range report plus period comparisons and breakdowns for one month or year. */
export async function fetchPeriodReport<T>(from: string, to: string, signal: AbortSignal): Promise<T> {
  const { data, error } = await sb().rpc("finance_period_report", { p_from: from, p_to: to }).abortSignal(signal);
  if (error) throw error;
  return data as unknown as T;
}

export type FinanceActivity = { id: string; entity_type: string; action: string; changes: Record<string, { from: unknown; to: unknown }>; created_at: string; actor: { display_name: string } | null };

export async function fetchFinanceHistory(entity: { kind: "expense" | "capital"; id: string }, signal: AbortSignal) {
  const { data, error } = await sb()
    .from("finance_activities")
    .select("id, entity_type, action, changes, created_at, actor:profiles!finance_activities_actor_id_fkey(display_name)")
    .eq("entity_type", entity.kind)
    .eq("entity_id", entity.id)
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

/** Notification types the signed-in user switched off (RLS: own row only). */
export async function fetchNotificationSettings(signal: AbortSignal): Promise<string[]> {
  const { data, error } = await sb().from("notification_settings").select("disabled_kinds").abortSignal(signal).maybeSingle();
  if (error) throw error;
  return data?.disabled_kinds ?? [];
}

export async function fetchDashboard<T>(fn: "dashboard_admin" | "dashboard_sales" | "dashboard_finance", arg: number | { from: string; to: string }, signal: AbortSignal): Promise<T> {
  const client = sb();
  const req = typeof arg === "object"
    ? client.rpc(fn as "dashboard_admin" | "dashboard_sales", { p_from: arg.from, p_to: arg.to })
    : fn === "dashboard_finance" ? client.rpc(fn, { p_months: arg }) : client.rpc(fn, { p_days: arg });
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

/** Range report aggregated in PostgreSQL (`from`/`to` are inclusive IST dates). */
export async function fetchReport<T>(fn: "report_leads" | "report_finance", from: string, to: string, signal: AbortSignal): Promise<T> {
  const { data, error } = await sb().rpc(fn, { p_from: from, p_to: to }).abortSignal(signal);
  if (error) throw error;
  return data as unknown as T;
}

/** Item names used before (in this expense category, by id), newest first and de-duplicated, for the form's suggestions. */
export async function fetchItemSuggestions(kind: "expense" | "capital", categoryId: string | null, signal: AbortSignal) {
  const q = kind === "expense"
    ? (categoryId ? sb().from("expenses").select("item").eq("category_id", categoryId) : sb().from("expenses").select("item"))
    : sb().from("capital_entries").select("item");
  const { data, error } = await q.not("item", "is", null).is("archived_at", null)
    .order("updated_at", { ascending: false }).limit(100).abortSignal(signal);
  if (error) throw error;
  const seen = new Map<string, string>();
  for (const r of data as { item: string }[]) {
    const label = r.item.trim();
    if (!seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  }
  return [...seen.values()].slice(0, 30);
}
