import "server-only";
import type { CurrentProfile } from "@/lib/auth";
import {
  followUpListArgs, followUpsQueryKey, leadListArgs, leadsQueryKey, parseFollowUpQuery, parseLeadQuery, unwrapStarredPage,
  type Initial, type StarredPageResult,
} from "@/lib/list-queries";
import { dashKey, defaultDashRange } from "@/lib/dashboard-keys";
import { createClient } from "@/lib/supabase/server";
import type { FollowUpListItem, LeadListItem } from "@/lib/types";

// The first read of a list page, started on the server while the page renders and streamed to the browser
// (useLiveQuery's `initial`), so the browser does not wait for its JavaScript before asking the database.
// Same RLS client and RPCs as the browser; any failure returns null and the browser reads as before.

type SearchParams = Record<string, string | string[] | undefined>;

export function toParams(sp: SearchParams) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) params.append(k, one);
  return params;
}

async function read<T>(key: string, fn: (sb: Awaited<ReturnType<typeof createClient>>) => Promise<T>): Initial<T> {
  try {
    return { key, data: await fn(await createClient()) };
  } catch {
    return null;
  }
}

export function initialLeads(profile: CurrentProfile, sp: SearchParams): Initial<StarredPageResult<LeadListItem>> {
  const q = parseLeadQuery(toParams(sp), profile.role === "admin");
  return read(leadsQueryKey(profile.id, q), async (sb) => {
    const { data, error } = await sb.rpc("list_leads", leadListArgs(q));
    if (error) throw error;
    return unwrapStarredPage<LeadListItem>(data, q.page, q.pageSize);
  });
}

export function initialFollowUps(profile: CurrentProfile, sp: SearchParams): Initial<StarredPageResult<FollowUpListItem>> {
  const q = parseFollowUpQuery(toParams(sp), profile.role === "admin");
  return read(followUpsQueryKey(profile.id, q), async (sb) => {
    const { data, error } = await sb.rpc("list_follow_ups", followUpListArgs(q));
    if (error) throw error;
    return unwrapStarredPage<FollowUpListItem>(data, q.page, q.pageSize);
  });
}

/** A dashboard for its default range, under the key dashboards.tsx uses. */
export function initialDashboard<T>(profile: CurrentProfile, kind: "admin" | "sales"): Initial<T> {
  const range = defaultDashRange();
  return read(dashKey(kind, profile.id, range), async (sb) => {
    const { data, error } = await sb.rpc(kind === "admin" ? "dashboard_admin" : "dashboard_sales", { p_from: range.from, p_to: range.to });
    if (error) throw error;
    return data as unknown as T;
  });
}
