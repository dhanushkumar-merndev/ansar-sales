"use client";

import { useState, useTransition } from "react";
import { Loader2, LogOut } from "lucide-react";
import { BrandMark, BrandName } from "@/components/app/brand";
import { ClientResults, defaultRange, type ResultSource } from "@/components/ads/client-results";
import { PortalLeads } from "@/components/ads/portal-leads";
import { PageHeader } from "@/components/common/page-header";
import { pastPresets, RangePicker, type DayRange } from "@/components/common/range-picker";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLiveQuery } from "@/hooks/use-live-query";
import type { AdAccount, AgencySource } from "@/lib/ads";
import { companyLogoUrl } from "@/lib/companies";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/time";
import { signOut } from "@/server/actions/auth";

type Portal = {
  client: { id: string; name: string; company_name: string | null; business: string | null; status: string; started_at: string };
  agency: { name: string; brand_highlight: string | null; logo_path: string | null };
  accounts: AdAccount[];
  /** Campaigns the agency runs for the client on its own ad account (one category each). */
  agency_sources: AgencySource[];
  /** The ads team switched on the client's leads (read-only list). */
  show_leads?: boolean;
};

const history = (a: AdAccount) => (a.archived_at ? " · earlier (history)" : "");

function portalSources(p: Portal): ResultSource[] {
  return [
    ...(p.agency_sources ?? []).map((s) => ({ accountId: s.account.id, categoryId: s.category_id, label: `Run by ${p.agency.name}${history(s.account)}` })),
    ...p.accounts.map((a) => ({ accountId: a.id, categoryId: null, label: `Your ad account · ${a.name ?? `act_${a.act_id}`}${history(a)}` })),
  ];
}

/** The caller's ads client: a client login's own, or the client whose CRM the caller works in. */
function usePortal() {
  return useLiveQuery({
    queryKey: "portal",
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("my_portal").abortSignal(signal);
      if (error) throw error;
      return data as unknown as Portal;
    },
    pollMs: 10 * 60_000,
  });
}

/** The date range and "synced" note of a results page, shown beside its title instead of on a row of their own. */
function useResultControls() {
  const [range, setRange] = useState<DayRange>(defaultRange);
  const [syncSlot, setSyncSlot] = useState<HTMLElement | null>(null);
  const controls = (
    <>
      <div ref={setSyncSlot} className="flex items-center gap-2" />
      <RangePicker value={range} onChange={(r) => r && setRange(r)} presets={pastPresets()} ariaLabel="Ads date range" align="end" />
    </>
  );
  return { range, syncSlot, controls };
}

/** The same read-only results inside the client's CRM, for the people working there. */
export function AdResultsView() {
  const portal = usePortal();
  const { range, syncSlot, controls } = useResultControls();
  const p = portal.data;
  const sources = p ? portalSources(p) : [];
  return (
    <>
      <PageHeader title="Ad results" description={p ? `Facebook and Instagram ads run with ${p.agency.name}, updated every hour.` : undefined}
        actions={sources.length ? controls : undefined} />
      {portal.error && !p ? <ErrorState message={portal.error} onRetry={portal.refetch} />
        : !p ? <ListSkeleton rows={8} />
        : !sources.length ? <EmptyState title="The ads aren't set up yet" description={`${p.agency.name} will set them up shortly. The results will appear here.`} />
        : <ClientResults clientId={p.client.id} sources={sources} canManage={false} range={range} syncSlot={syncSlot} />}
    </>
  );
}

/** An ads client's own, read-only view of their ad results. */
export function PortalView() {
  const portal = usePortal();
  const [leaving, startLeaving] = useTransition();
  const { range, syncSlot, controls } = useResultControls();
  const [tab, setTab] = useState("results");
  const p = portal.data;
  const sources = p ? portalSources(p) : [];
  const results = !p ? null : !sources.length ? (
    <EmptyState title="Your ads aren't set up yet" description={`${p.agency.name} will set them up shortly. Your results will appear here.`} />
  ) : (
    <ClientResults clientId={p.client.id} sources={sources} canManage={false} range={range} syncSlot={syncSlot} />
  );

  return (
    <div className="min-h-svh bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <BrandMark size={32} logoUrl={companyLogoUrl(p?.agency.logo_path)} />
          <div className="min-w-0 flex-1 leading-tight">
            {p ? <BrandName name={p.agency.name} highlight={p.agency.brand_highlight} className="text-sm font-semibold" /> : <span className="text-sm">&nbsp;</span>}
            <p className="truncate text-xs text-muted-foreground">Ad results for {p?.client.name ?? "…"}</p>
          </div>
          <Button variant="ghost" size="sm" disabled={leaving} onClick={() => startLeaving(() => signOut())}>
            {leaving ? <Loader2 className="animate-spin" /> : <LogOut />} Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 pt-5 pb-12 sm:px-6">
        {portal.error && !p ? <ErrorState message={portal.error} onRetry={portal.refetch} />
          : !p ? <ListSkeleton rows={8} />
          : (
            <>
              <PageHeader title={p.client.company_name ?? p.client.business ?? p.client.name}
                description={`Your Facebook and Instagram ads, updated every hour. Working with ${p.agency.name} since ${formatDate(p.client.started_at)}.`}
                actions={sources.length && (!p.show_leads || tab === "results") ? controls : undefined} />
              {p.show_leads ? (
                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList>
                    <TabsTrigger value="results">Ad results</TabsTrigger>
                    <TabsTrigger value="leads">Leads</TabsTrigger>
                  </TabsList>
                  <TabsContent value="results" className="pt-3">{results}</TabsContent>
                  <TabsContent value="leads" className="pt-3"><PortalLeads /></TabsContent>
                </Tabs>
              ) : results}
            </>
          )}
      </main>
    </div>
  );
}
