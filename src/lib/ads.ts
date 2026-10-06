/** Shapes returned by the ads RPCs (supabase/migrations/20261006009610_ads_data.sql) and KPI helpers. */

export type AdScope = "all" | "company" | "client";

export type AdAccount = {
  id: string; kind: "company" | "client"; company_id: string; company_name: string; ads_client_id: string | null;
  act_id: string; name: string | null; currency: string | null; timezone: string | null; app_id: string | null;
  status: "unverified" | "connected" | "error"; sync_paused: boolean; last_checked_at: string | null; last_synced_at: string | null;
  synced_through: string | null; backfilled_from: string | null; last_error: string | null; archived_at: string | null;
  created_at: string; scope: AdScope;
};

export type AdTotals = {
  spend: number; impressions: number; reach_daily_sum: number; clicks: number; link_clicks: number; leads: number;
  conversions: number; conversion_value: number; campaigns: number; active_campaigns: number;
};

export type AdsOverview = {
  account: AdAccount;
  range: { from: string; to: string; days: number };
  totals: AdTotals;
  reach_month: number | null;
  daily: { date: string; spend: number; impressions: number; clicks: number; leads: number; conversions: number }[];
  campaigns: { id: string; name: string; spend: number; leads: number; clicks: number; impressions: number }[];
  categories: { id: string | null; name: string; company_id: string | null; spend: number; leads: number }[] | null;
};

export type AdCampaignRow = {
  id: string; meta_id: string; name: string; objective: string | null; status: string | null; effective_status: string | null;
  daily_budget: number | null; lifetime_budget: number | null; created_time: string | null; start_time: string | null; stop_time: string | null;
  category: { id: string; name: string } | null;
  spend: number; impressions: number; clicks: number; link_clicks: number; leads: number; conversions: number;
  last_active: string | null; ads: number;
};

export type AdCategory = { id: string; name: string; company_id: string | null; match_text: string | null; campaigns: number };

export type AdCampaignDetail = {
  campaign: Omit<AdCampaignRow, "spend" | "impressions" | "clicks" | "link_clicks" | "leads" | "conversions" | "last_active" | "ads">;
  daily: { date: string; spend: number; impressions: number; clicks: number; leads: number; reach: number }[];
  ads: {
    id: string; meta_id: string; name: string; status: string | null; effective_status: string | null; created_time: string | null;
    updated_time: string | null; thumbnail_url: string | null; preview_url: string | null; spend: number; impressions: number; clicks: number; leads: number;
  }[];
};

export type AdsClientStatus = "onboarding" | "active" | "paused" | "closed";
export const ADS_CLIENT_STATUS_LABELS: Record<AdsClientStatus, string> = {
  onboarding: "Onboarding", active: "Active", paused: "Paused", closed: "Closed",
};

export type AdsClient = {
  id: string; company_id: string; lead_id: string | null; name: string; phone: string | null; email: string | null; business: string | null;
  status: AdsClientStatus; notes: string | null; started_at: string; closed_at: string | null; created_at: string;
};

/** Ratio or null when the denominator is zero (shown as "—", never as 0 or Infinity). */
const ratio = (a: number, b: number, scale = 1) => (b > 0 ? (a / b) * scale : null);

/** Derived KPIs. Meta's definitions: CTR = clicks / impressions, CPM = cost per 1,000 impressions. */
export function adKpis(t: Pick<AdTotals, "spend" | "impressions" | "clicks" | "leads" | "conversions" | "conversion_value">, reach?: number | null) {
  const n = (v: number | string) => Number(v) || 0;
  const spend = n(t.spend);
  return {
    ctr: ratio(n(t.clicks), n(t.impressions), 100),
    cpc: ratio(spend, n(t.clicks)),
    cpm: ratio(spend, n(t.impressions), 1000),
    cpl: ratio(spend, n(t.leads)),
    costPerConversion: ratio(spend, n(t.conversions)),
    roas: n(t.conversion_value) > 0 ? ratio(n(t.conversion_value), spend) : null,
    frequency: reach ? ratio(n(t.impressions), reach) : null,
  };
}

/** Money in the ad account's own currency (accounts are never summed across currencies). */
export function moneyFormat(currency: string | null | undefined, compact = false) {
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "INR";
  const f = new Intl.NumberFormat("en-IN", {
    style: "currency", currency: code, maximumFractionDigits: compact ? 1 : 2, ...(compact ? { notation: "compact" as const } : {}),
  });
  return (v: number | string | null | undefined) => f.format(Number(v ?? 0));
}

export const formatPercent = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}%`);
export const formatRatio = (v: number | null, digits = 2) => (v === null ? "—" : v.toFixed(digits));

/** Meta's effective_status values in plain words. */
export function campaignStatusLabel(status: string | null) {
  if (!status) return "Unknown";
  const map: Record<string, string> = {
    ACTIVE: "Active", PAUSED: "Paused", CAMPAIGN_PAUSED: "Paused", ADSET_PAUSED: "Paused", ARCHIVED: "Archived", DELETED: "Deleted",
    IN_PROCESS: "Processing", WITH_ISSUES: "With issues", PENDING_REVIEW: "In review", DISAPPROVED: "Rejected", PREAPPROVED: "Approved",
  };
  return map[status] ?? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
}

/** Plain-language objective (Meta's OUTCOME_* names). */
export function objectiveLabel(objective: string | null) {
  if (!objective) return null;
  return objective.replace(/^OUTCOME_/, "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
