// URL → query parsing and RPC arguments for the lead and follow-up lists, shared by the browser
// (src/lib/queries.ts) and the server's first read (src/server/initial-data.ts), so both build the same query key.
import { LEAD_TEMPERATURES, LEADS_PAGE_SIZE, type LeadTemperature } from "@/lib/constants";
import type { Json } from "@/lib/database.types";
import { parsePaging, toPageResult, type PageResult } from "@/lib/pagination";
import { cleanSearch } from "@/lib/search";
import { addDays, istDayStartUtc } from "@/lib/time";

type Params = { get(name: string): string | null };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;
export const LEAD_SORTS = ["created_at", "updated_at", "name", "status", "next_follow_up"] as const;

/** A valid from–to day range from the URL, or none. */
function dayRange(params: Params) {
  const from = params.get("from");
  const to = params.get("to");
  return from && to && DATE_RE.test(from) && DATE_RE.test(to) && from <= to ? { from, to } : { from: null, to: null };
}

/** A first read the server started for one query key (null when it failed: the browser reads instead). */
export type Initial<T> = Promise<{ key: string; data: T } | null>;

/** A page from a list that supports stars, plus how many of the user's items are pinned (max 10). */
export type StarredPageResult<T> = PageResult<T> & { pinnedCount: number };

export function unwrapStarredPage<T>(data: Json | null, page: number, pageSize: number): StarredPageResult<T> {
  const r = (data ?? { items: [], total: 0 }) as unknown as { items: T[]; total: number; pinned_count?: number };
  return { ...toPageResult(r.items, Number(r.total), page, pageSize), pinnedCount: Number(r.pinned_count ?? 0) };
}

export type LeadQuery = {
  /** Pipeline stage id. */
  q: string; stage: string | null; niche: string | null; owner: string | null; temperature: LeadTemperature | null;
  from: string | null; to: string | null; overdue: boolean; archived: boolean; starred: boolean;
  sort: string; dir: "asc" | "desc"; page: number; pageSize: number;
};

/** Sanitized lead-list state from the URL (the database validates again). */
export function parseLeadQuery(params: Params, isAdmin: boolean): LeadQuery {
  const { page, pageSize } = parsePaging(params, LEADS_PAGE_SIZE);
  const stage = params.get("stage");
  const temp = params.get("temp");
  const sort = params.get("sort");
  return {
    q: cleanSearch(params.get("q")),
    stage: UUID_RE.test(stage ?? "") ? stage : null,
    niche: UUID_RE.test(params.get("niche") ?? "") ? params.get("niche") : null,
    owner: isAdmin && UUID_RE.test(params.get("owner") ?? "") ? params.get("owner") : null,
    temperature: LEAD_TEMPERATURES.includes(temp as LeadTemperature) ? (temp as LeadTemperature) : null,
    ...dayRange(params),
    overdue: params.get("overdue") === "1",
    archived: isAdmin && params.get("archived") === "1",
    starred: params.get("tab") === "starred",
    sort: LEAD_SORTS.includes(sort as (typeof LEAD_SORTS)[number]) ? sort! : "created_at",
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    page,
    pageSize,
  };
}

export const leadsQueryKey = (userId: string, q: LeadQuery) => `leads:${userId}:${JSON.stringify(q)}`;

export function leadListArgs(p: LeadQuery) {
  return {
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
    p_temperature: p.temperature ?? undefined,
  };
}

export type FollowUpView = "overdue" | "today" | "upcoming" | "completed" | "cancelled" | "starred";
export const FOLLOW_UP_VIEWS: FollowUpView[] = ["overdue", "today", "upcoming", "completed", "cancelled", "starred"];

export type FollowUpQuery = {
  view: FollowUpView; assignee: string | null; q: string; from?: string | null; to?: string | null; page: number; pageSize: number;
};

/** Sanitized follow-up list state from the URL ("today" by default). */
export function parseFollowUpQuery(params: Params, isAdmin: boolean) {
  const view = FOLLOW_UP_VIEWS.includes(params.get("view") as FollowUpView) ? (params.get("view") as FollowUpView) : "today";
  const assignee = isAdmin && UUID_RE.test(params.get("assignee") ?? "") ? params.get("assignee") : null;
  return { view, assignee, q: cleanSearch(params.get("q")), ...dayRange(params), ...parsePaging(params) };
}

export const followUpsQueryKey = (userId: string, q: ReturnType<typeof parseFollowUpQuery>) => `follow-ups:${userId}:${JSON.stringify(q)}`;

export function followUpListArgs(p: FollowUpQuery) {
  return {
    p_view: p.view,
    p_assignee_id: p.assignee ?? undefined,
    p_search: cleanSearch(p.q) || undefined,
    p_limit: p.pageSize,
    p_offset: (p.page - 1) * p.pageSize,
    p_due_from: p.from ? istDayStartUtc(p.from) : undefined,
    p_due_to: p.to ? istDayStartUtc(addDays(p.to, 1)) : undefined,
  };
}
