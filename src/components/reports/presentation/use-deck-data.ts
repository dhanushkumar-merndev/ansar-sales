"use client";

import { useProfile } from "@/components/providers/profile-provider";
import type { ReportRange } from "@/components/reports/report-range-picker";
import type { FinanceReport, LeadReport } from "@/components/reports/reports-view";
import { useLiveQuery } from "@/hooks/use-live-query";
import type { AdAccount, AdsClient, AdsOverview } from "@/lib/ads";
import { can } from "@/lib/permissions";
import { fetchReport } from "@/lib/queries";
import { createClient } from "@/lib/supabase/client";

export type DeckClient = AdsClient & { account: AdAccount | null; last_30d: { spend: number; leads: number; clicks: number; impressions: number } };

/** The company's own (or merged) ad account overview; null when no ad account is connected. */
export type DeckAds = { overview: AdsOverview | null };

export type DeckData = {
  leads: LeadReport | null;
  finance: FinanceReport | null;
  ads: DeckAds | null;
  clients: { items: DeckClient[]; total: number } | null;
};

const CLIENT_LIMIT = 100;

/**
 * Everything the presentation shows, from the same RPCs as the Reports and Ads pages (they enforce
 * access and the current company). Each source is fetched only when the role may see it, and stays
 * live through Realtime like the report tabs.
 */
export function useDeckData(range: ReportRange) {
  const profile = useProfile();
  const showLeads = can.useLeads(profile.roles);
  const showFinance = can.useFinance(profile.roles);
  const showAds = can.useAds(profile.roles) && !profile.features.includes("no_ads");
  const scope = `${profile.company.id}:${profile.id}:${range.from}:${range.to}`;

  const leads = useLiveQuery({
    queryKey: `deck-leads:${scope}`,
    fetcher: (s) => fetchReport<LeadReport>("report_leads", range.from, range.to, s),
    tables: ["leads", "follow_ups", "lead_activities"],
    enabled: showLeads,
    pollMs: 0,
  });

  const finance = useLiveQuery({
    queryKey: `deck-finance:${scope}`,
    fetcher: (s) => fetchReport<FinanceReport>("report_finance", range.from, range.to, s),
    tables: ["expenses", "capital_entries"],
    enabled: showFinance,
    pollMs: 0,
  });

  const ads = useLiveQuery({
    queryKey: `deck-ads:${scope}`,
    fetcher: async (signal): Promise<DeckAds> => {
      const sb = createClient();
      const { data: accounts, error } = await sb.rpc("ads_accounts_for_me").abortSignal(signal);
      if (error) throw error;
      const list = (accounts ?? []) as unknown as AdAccount[];
      const account = list.find((a) => a.company_id === profile.company.id && !a.archived_at) ?? list.find((a) => !a.archived_at) ?? list[0];
      if (!account) return { overview: null };
      const { data, error: e2 } = await sb.rpc("ads_overview", { p_account: account.id, p_from: range.from, p_to: range.to }).abortSignal(signal);
      if (e2) throw e2;
      return { overview: data as unknown as AdsOverview };
    },
    enabled: showAds,
    pollMs: 5 * 60_000,
  });

  const clients = useLiveQuery({
    queryKey: `deck-clients:${scope}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("list_ads_clients", { p_limit: CLIENT_LIMIT, p_offset: 0 }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as { items: DeckClient[]; total: number };
    },
    enabled: showAds,
    pollMs: 5 * 60_000,
  });

  const sources = [
    { on: showLeads, q: leads },
    { on: showFinance, q: finance },
    { on: showAds, q: ads },
    { on: showAds, q: clients },
  ].filter((s) => s.on);

  const data: DeckData = {
    leads: showLeads ? leads.data ?? null : null,
    finance: showFinance ? finance.data ?? null : null,
    ads: showAds ? ads.data ?? null : null,
    clients: showAds ? clients.data ?? null : null,
  };

  return {
    data,
    // Wait for every source (or its error) so the slide list does not jump while the deck is open.
    loading: sources.some((s) => s.q.data === undefined && !s.q.error),
    // One failing source only drops its slides; the deck fails only when nothing loaded.
    error: sources.length && sources.every((s) => s.q.error && s.q.data === undefined) ? sources[0].q.error : null,
    isFetching: sources.some((s) => s.q.isFetching),
    retry: () => sources.forEach((s) => s.q.refetch()),
  };
}
