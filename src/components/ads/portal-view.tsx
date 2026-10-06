"use client";

import { useState, useTransition } from "react";
import { Loader2, LogOut } from "lucide-react";
import { BrandMark, BrandName } from "@/components/app/brand";
import { AdsDashboard } from "@/components/ads/ads-dashboard";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveQuery } from "@/hooks/use-live-query";
import type { AdAccount } from "@/lib/ads";
import { companyLogoUrl } from "@/lib/companies";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/time";
import { signOut } from "@/server/actions/auth";

type Portal = {
  client: { id: string; name: string; business: string | null; status: string; started_at: string };
  agency: { name: string; brand_highlight: string | null; logo_path: string | null };
  accounts: AdAccount[];
};

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
  const [accountId, setAccountId] = useState<string | null>(null);
  const [leaving, startLeaving] = useTransition();
  const p = portal.data;
  const account = p?.accounts.find((a) => a.id === accountId) ?? p?.accounts[0];

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
              {!account ? (
                <EmptyState title="Your ad account isn't connected yet" description={`${p.agency.name} will connect it shortly. Your results will appear here.`} />
              ) : (
                <div className="space-y-4">
                  {p.accounts.length > 1 ? (
                    <Select value={account.id} onValueChange={setAccountId}>
                      <SelectTrigger className="w-80" aria-label="Ad account"><SelectValue /></SelectTrigger>
                      <SelectContent>{p.accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name ?? `act_${a.act_id}`}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : null}
                  <AdsDashboard key={account.id} accountId={account.id} canManage={false} />
                </div>
              )}
            </>
          )}
      </main>
    </div>
  );
}
