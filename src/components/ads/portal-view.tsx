"use client";

import { useTransition } from "react";
import { Loader2, LogOut } from "lucide-react";
import { BrandMark, BrandName } from "@/components/app/brand";
import { ClientResults, type ResultSource } from "@/components/ads/client-results";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { useLiveQuery } from "@/hooks/use-live-query";
import type { AdAccount, AgencySource } from "@/lib/ads";
import { companyLogoUrl } from "@/lib/companies";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/time";
import { signOut } from "@/server/actions/auth";

type Portal = {
  client: { id: string; name: string; business: string | null; status: string; started_at: string };
  agency: { name: string; brand_highlight: string | null; logo_path: string | null };
  accounts: AdAccount[];
  /** Campaigns the agency runs for the client on its own ad account (one category each). */
  agency_sources: AgencySource[];
};

const history = (a: AdAccount) => (a.archived_at ? " · earlier (history)" : "");

function portalSources(p: Portal): ResultSource[] {
  return [
    ...(p.agency_sources ?? []).map((s) => ({ accountId: s.account.id, categoryId: s.category_id, label: `Run by ${p.agency.name}${history(s.account)}` })),
    ...p.accounts.map((a) => ({ accountId: a.id, categoryId: null, label: `Your ad account · ${a.name ?? `act_${a.act_id}`}${history(a)}` })),
  ];
}

/** An ads client's own, read-only view of their ad results. */
export function PortalView() {
  const portal = useLiveQuery({
    queryKey: "portal",
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("my_portal").abortSignal(signal);
      if (error) throw error;
      return data as unknown as Portal;
    },
    pollMs: 10 * 60_000,
  });
  const [leaving, startLeaving] = useTransition();
  const p = portal.data;
  const sources = p ? portalSources(p) : [];

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
              <div className="mb-5">
                <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{p.client.business ?? p.client.name}</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your Facebook and Instagram ads, updated every hour. Working with {p.agency.name} since {formatDate(p.client.started_at)}.
                </p>
              </div>
              {!sources.length ? (
                <EmptyState title="Your ads aren't set up yet" description={`${p.agency.name} will set them up shortly. Your results will appear here.`} />
              ) : (
                <ClientResults clientId={p.client.id} sources={sources} canManage={false} />
              )}
            </>
          )}
      </main>
    </div>
  );
}
