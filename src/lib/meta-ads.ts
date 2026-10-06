import { createHmac } from "node:crypto";
import { GRAPH_VERSION } from "@/lib/meta";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** The Meta app secret and system-user token of one ad account (server only). */
export type AdCreds = { appSecret: string; token: string };

/** A Graph API error with Meta's code, so rate limits can be told apart from broken access. */
export class MetaApiError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
  }
}

/** Meta's throttling codes: back off and try again later rather than marking the account broken. */
export const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80000, 80003, 80004, 80014]);

/** HMAC-SHA256 of the token with the app secret; proves the call comes from the app's own server. */
export function appSecretProof(token: string, appSecret: string) {
  return createHmac("sha256", appSecret).update(token, "utf8").digest("hex");
}

async function request<T>(url: URL): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
  if (!res.ok || body.error) {
    throw new MetaApiError((body.error?.message ?? `Meta returned ${res.status}`).slice(0, 300), body.error?.code ?? null);
  }
  return body;
}

function graphUrl(path: string, creds: AdCreds, params: Record<string, string> = {}) {
  const url = new URL(`${GRAPH}/${path.replace(/^\//, "")}`);
  url.search = new URLSearchParams({ ...params, access_token: creds.token, appsecret_proof: appSecretProof(creds.token, creds.appSecret) }).toString();
  return url;
}

/** One GET call. Errors carry Meta's own message (never the token). */
export function adsGraph<T>(path: string, creds: AdCreds, params?: Record<string, string>) {
  return request<T>(graphUrl(path, creds, params));
}

/** Every page of a list endpoint (bounded, so a huge account can't run forever). */
async function allPages<T>(path: string, creds: AdCreds, params: Record<string, string>, maxPages = 40): Promise<T[]> {
  const out: T[] = [];
  let url: URL | null = graphUrl(path, creds, params);
  for (let page = 0; url && page < maxPages; page++) {
    const body: { data?: T[]; paging?: { next?: string } } = await request(url);
    out.push(...(body.data ?? []));
    url = body.paging?.next ? new URL(body.paging.next) : null;
  }
  return out;
}

// Currencies Meta reports without minor units (budgets are given in the smallest unit).
const ZERO_DECIMAL = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);

/** Meta budgets are strings in minor units ("150000" = ₹1,500.00). */
export function budgetToMajor(minor: string | number | null | undefined, currency: string | null) {
  if (minor === null || minor === undefined || minor === "") return null;
  const n = Number(minor);
  if (!Number.isFinite(n)) return null;
  return currency && ZERO_DECIMAL.has(currency) ? n : n / 100;
}

type Action = { action_type: string; value: string };

const LEAD_ACTIONS = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];
const PURCHASE_ACTIONS = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"];

/**
 * Leads and purchases from Meta's `actions` / `action_values`. Meta reports the same result under
 * several overlapping action types, so the first type present wins instead of adding them up.
 */
export function mapActions(actions: Action[] | undefined, values: Action[] | undefined) {
  const first = (list: Action[] | undefined, types: string[]) => {
    for (const t of types) {
      const hit = list?.find((a) => a.action_type === t);
      if (hit) return Number(hit.value) || 0;
    }
    return 0;
  };
  return {
    leads: Math.round(first(actions, LEAD_ACTIONS)),
    conversions: Math.round(first(actions, PURCHASE_ACTIONS)),
    conversion_value: Math.round(first(values, PURCHASE_ACTIONS) * 100) / 100,
  };
}

export type AdAccountInfo = { name: string; currency: string; timezone: string; status: number };

export async function fetchAdAccount(actId: string, creds: AdCreds): Promise<AdAccountInfo> {
  const a = await adsGraph<{ name?: string; currency?: string; timezone_name?: string; account_status?: number }>(
    `act_${actId}`, creds, { fields: "name,currency,timezone_name,account_status" });
  return { name: a.name ?? `act_${actId}`, currency: a.currency ?? "INR", timezone: a.timezone_name ?? "Asia/Kolkata", status: a.account_status ?? 1 };
}

export async function fetchCampaigns(actId: string, creds: AdCreds, currency: string | null) {
  const list = await allPages<{
    id: string; name: string; objective?: string; status?: string; effective_status?: string;
    daily_budget?: string; lifetime_budget?: string; created_time?: string; start_time?: string; stop_time?: string;
  }>(`act_${actId}/campaigns`, creds, {
    fields: "id,name,objective,status,effective_status,daily_budget,lifetime_budget,created_time,start_time,stop_time",
    limit: "200",
  });
  return list.map((c) => ({
    meta_id: c.id, name: c.name, objective: c.objective ?? null, status: c.status ?? null, effective_status: c.effective_status ?? null,
    daily_budget: budgetToMajor(c.daily_budget, currency), lifetime_budget: budgetToMajor(c.lifetime_budget, currency),
    created_time: c.created_time ?? null, start_time: c.start_time ?? null, stop_time: c.stop_time ?? null,
  }));
}

export async function fetchAds(actId: string, creds: AdCreds) {
  const list = await allPages<{
    id: string; name: string; campaign_id?: string; status?: string; effective_status?: string; created_time?: string;
    updated_time?: string; creative?: { thumbnail_url?: string }; preview_shareable_link?: string;
  }>(`act_${actId}/ads`, creds, {
    fields: "id,name,campaign_id,status,effective_status,created_time,updated_time,creative{thumbnail_url},preview_shareable_link",
    limit: "200",
  });
  return list.filter((a) => a.campaign_id).map((a) => ({
    meta_id: a.id, campaign_meta_id: a.campaign_id, name: a.name, status: a.status ?? null, effective_status: a.effective_status ?? null,
    created_time: a.created_time ?? null, updated_time: a.updated_time ?? null,
    thumbnail_url: a.creative?.thumbnail_url ?? null, preview_url: a.preview_shareable_link ?? null,
  }));
}

type InsightRow = {
  campaign_id?: string; campaign_name?: string; ad_id?: string; ad_name?: string; date_start: string;
  spend?: string; impressions?: string; reach?: string; clicks?: string; inline_link_clicks?: string;
  actions?: Action[]; action_values?: Action[];
};

/** Daily insights per campaign or per ad for [since, until] (YYYY-MM-DD, the ad account's own days). */
export async function fetchInsights(actId: string, creds: AdCreds, level: "campaign" | "ad", since: string, until: string) {
  const rows = await allPages<InsightRow>(`act_${actId}/insights`, creds, {
    level,
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields: [
      "campaign_id", "campaign_name", ...(level === "ad" ? ["ad_id", "ad_name"] : []),
      "spend", "impressions", "reach", "clicks", "inline_link_clicks", "actions", "action_values",
    ].join(","),
    limit: "500",
  }, 100);
  return rows.filter((r) => r.campaign_id).map((r) => ({
    campaign_meta_id: r.campaign_id, campaign_name: r.campaign_name ?? null,
    ad_meta_id: r.ad_id ?? null, ad_name: r.ad_name ?? null,
    date: r.date_start,
    spend: Number(r.spend ?? 0), impressions: Number(r.impressions ?? 0), reach: Number(r.reach ?? 0),
    clicks: Number(r.clicks ?? 0), link_clicks: Number(r.inline_link_clicks ?? 0),
    ...mapActions(r.actions, r.action_values),
    actions: r.actions ?? null,
  }));
}

/** Unique reach for one whole calendar month: the account total and each campaign. */
export async function fetchMonthlyReach(actId: string, creds: AdCreds, monthStart: string, monthEnd: string) {
  const time_range = JSON.stringify({ since: monthStart, until: monthEnd });
  const [account, campaigns] = await Promise.all([
    allPages<{ reach?: string }>(`act_${actId}/insights`, creds, { level: "account", time_range, fields: "reach" }),
    allPages<{ campaign_id?: string; reach?: string }>(`act_${actId}/insights`, creds, { level: "campaign", time_range, fields: "campaign_id,reach", limit: "500" }),
  ]);
  return [
    { campaign_meta_id: null, month: monthStart, reach: Number(account[0]?.reach ?? 0) },
    ...campaigns.filter((c) => c.campaign_id).map((c) => ({ campaign_meta_id: c.campaign_id, month: monthStart, reach: Number(c.reach ?? 0) })),
  ];
}

/** Today's date (YYYY-MM-DD) in the ad account's timezone, which is how Meta reports days. */
export function todayIn(timezone: string | null, now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone ?? "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  }
}

/** Adds days to a YYYY-MM-DD date (calendar arithmetic in UTC, no timezone drift). */
export function shiftDay(day: string, days: number) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Splits [since, until] into windows of at most `size` days, oldest first. */
export function dayWindows(since: string, until: string, size = 30) {
  const out: { since: string; until: string }[] = [];
  for (let start = since; start <= until; start = shiftDay(start, size)) {
    const end = shiftDay(start, size - 1);
    out.push({ since: start, until: end < until ? end : until });
  }
  return out;
}
