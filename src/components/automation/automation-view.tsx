"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowRight, ChartColumn, ExternalLink, Handshake, Megaphone } from "lucide-react";
import { toast } from "sonner";
import { AdAccountStatus } from "@/components/ads/ad-account-form";
import { ConnectionCard, fetchMetaOverview, InboxCard, MetaStatusBadge, RoutingCard, type MetaOverview } from "@/components/automation/facebook-leads";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLiveQuery } from "@/hooks/use-live-query";
import type { AdAccount } from "@/lib/ads";
import { createClient } from "@/lib/supabase/client";
import { formatRelative } from "@/lib/time";
import { setWonToAdsClient } from "@/server/actions/ads";

function FacebookLogo({ className }: { className?: string }) {
  return (
    <span className={`grid size-10 shrink-0 place-items-center rounded-xl bg-[#1877F2] text-white ${className ?? ""}`} aria-hidden>
      <svg viewBox="0 0 24 24" className="size-6" fill="currentColor">
        <path d="M13.5 21v-7.5h2.5l.4-3h-2.9V8.6c0-.9.3-1.5 1.5-1.5h1.5V4.4c-.3 0-1.2-.1-2.2-.1-2.2 0-3.8 1.4-3.8 3.9v2.3H8v3h2.5V21h3z" />
      </svg>
    </span>
  );
}

function routingSummary(c: MetaOverview) {
  const names = c.candidates.filter((u) => c.routing.includes(u.id)).map((u) => u.display_name);
  if (names.length === 0) return "New leads go to the company admin";
  if (names.length === 1) return `New leads go to ${names[0]}`;
  return `Shared in turn between ${names.join(", ")}`;
}

async function fetchAdAccounts(signal: AbortSignal) {
  const { data, error } = await createClient().rpc("ads_accounts_for_me").abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as unknown as AdAccount[];
}

/** Admin: the company's Facebook connection (lead forms + ads) and the won-lead hand-over. */
export function AutomationView() {
  const profile = useProfile();
  const overview = useLiveQuery({ queryKey: "meta-overview", fetcher: fetchMetaOverview, tables: ["profiles"], pollMs: 0 });
  const accounts = useLiveQuery({ queryKey: `ads-accounts:${profile.company.id}`, fetcher: fetchAdAccounts, pollMs: 0 });
  const [open, setOpen] = useState(false);
  const company = overview.data?.find((c) => c.company_id === profile.company.id);
  const ownAds = accounts.data?.find((a) => a.company_id === profile.company.id && !a.archived_at) ?? null;
  const sharedAds = accounts.data?.find((a) => a.company_id !== profile.company.id && !a.archived_at) ?? null;
  const i = company?.integration;
  const loaded = Boolean(company && accounts.data);
  const connected = Boolean(i || ownAds);
  const overall = i?.status === "error" || ownAds?.status === "error" ? "error"
    : i?.status === "connected" || ownAds?.status === "connected" ? "connected" : connected ? "unverified" : "none";
  const refetch = () => { overview.refetch(); accounts.refetch(); };

  return (
    <>
      <PageHeader title="Automation" description={`Connect Facebook leads and ads to ${profile.company.name}.`} />
      {overview.error && !overview.data ? <ErrorState message={overview.error} onRetry={overview.refetch} /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Card className="flex flex-col md:col-span-1 xl:col-span-2">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <FacebookLogo />
                {loaded ? <MetaStatusBadge status={overall} /> : <Skeleton className="h-5 w-24" />}
              </div>
              <CardTitle className="pt-2">Facebook</CardTitle>
              <CardDescription>
                One Meta app for both: leads from your Facebook and Instagram lead forms arrive in seconds, and the Ads page shows
                amount spent, reach, impressions and cost per result for every campaign.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid flex-1 gap-4 text-sm sm:grid-cols-2">
              {!loaded || !company ? <><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></> : (
                <>
                  <div className="space-y-1 rounded-lg border p-3">
                    <div className="flex items-center gap-2 font-medium"><span>Lead forms</span><MetaStatusBadge status={i?.status ?? "none"} /></div>
                    {i ? (
                      <div className="space-y-0.5 text-muted-foreground">
                        <p>Page: <span className="text-foreground">{i.page_name ?? i.page_id}</span></p>
                        <p>{routingSummary(company)}</p>
                        <p>Last 7 days: {company.leads_7d} new{company.failed_7d ? `, ${company.failed_7d} failed` : ""}</p>
                      </div>
                    ) : <p className="text-muted-foreground">Add your Page ID to receive lead form submissions.</p>}
                  </div>
                  <div className="space-y-1 rounded-lg border p-3">
                    <div className="flex items-center gap-2 font-medium"><span>Ads dashboard</span><AdAccountStatus account={ownAds ?? sharedAds} /></div>
                    {ownAds ? (
                      <div className="space-y-0.5 text-muted-foreground">
                        <p>Account: <span className="text-foreground">{ownAds.name ?? `act_${ownAds.act_id}`}</span>{ownAds.currency ? ` · ${ownAds.currency}` : ""}</p>
                        <p>{ownAds.last_synced_at ? `Synced ${formatRelative(ownAds.last_synced_at)}` : "Waiting for the first sync"}</p>
                      </div>
                    ) : sharedAds ? (
                      <p className="text-muted-foreground">Uses {sharedAds.company_name}&apos;s ad account; you see your company&apos;s campaigns.</p>
                    ) : <p className="text-muted-foreground">Add your ad account ID to see spend and results.</p>}
                  </div>
                </>
              )}
            </CardContent>
            <CardFooter className="flex-wrap gap-2">
              {i ? <Button variant="outline" asChild><Link href="/automation/facebook"><ChartColumn /> Lead insights</Link></Button> : null}
              {ownAds || sharedAds ? <Button variant="outline" asChild><Link href="/ads"><Megaphone /> Ads dashboard</Link></Button> : null}
              <Button className="ml-auto" variant={connected ? "outline" : "default"} disabled={!loaded} onClick={() => setOpen(true)}>
                {connected ? "Manage" : "Connect Facebook"} <ArrowRight />
              </Button>
            </CardFooter>
          </Card>
          <WonToClientCard />
        </div>
      )}
      {company ? <FacebookDialog open={open} onOpenChange={setOpen} company={company} adAccount={ownAds} onChanged={refetch} /> : null}
    </>
  );
}

function FacebookDialog({ open, onOpenChange, company, adAccount, onChanged }: {
  open: boolean; onOpenChange: (open: boolean) => void; company: MetaOverview; adAccount: AdAccount | null; onChanged: () => void;
}) {
  const [tab, setTab] = useState(company.integration ? "routing" : "connection");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(88svh,780px)] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
          <FacebookLogo />
          <div className="min-w-0 flex-1">
            <DialogTitle>Facebook</DialogTitle>
            <DialogDescription>
              For {company.company_name}.{" "}
              <Link href="/help/meta-lead-ads" target="_blank" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground">
                Setup guide <ExternalLink className="size-3" />
              </Link>
            </DialogDescription>
          </div>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList className="w-full">
            <TabsTrigger value="connection">Connection</TabsTrigger>
            <TabsTrigger value="routing">Lead routing</TabsTrigger>
            <TabsTrigger value="inbox">Recent leads</TabsTrigger>
          </TabsList>
          <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6 pt-3">
            <TabsContent value="connection">
              <ConnectionCard key={`${company.company_id}:${adAccount?.id ?? ""}`} company={company} adAccount={adAccount} onChanged={onChanged} embedded />
            </TabsContent>
            <TabsContent value="routing">
              <RoutingCard key={company.routing.join(",")} company={company} onChanged={onChanged} embedded />
            </TabsContent>
            <TabsContent value="inbox"><InboxCard companyId={company.company_id} embedded /></TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

/** Won leads become ads clients for the ads team (per company). */
function WonToClientCard() {
  const profile = useProfile();
  const setting = useLiveQuery({
    queryKey: `won-to-ads-client:${profile.company.id}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().from("companies").select("won_to_ads_client").eq("id", profile.company.id).abortSignal(signal).maybeSingle();
      if (error) throw error;
      return Boolean(data?.won_to_ads_client);
    },
    pollMs: 0,
  });
  const [pending, start] = useTransition();
  const toggle = (enabled: boolean) => start(async () => {
    const r = await setWonToAdsClient({ companyId: profile.company.id, enabled });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(enabled ? "Won leads now go to the ads team" : "Turned off");
    setting.refetch();
  });
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <span className="grid size-10 place-items-center rounded-xl bg-emerald-500/10 text-emerald-300" aria-hidden><Handshake className="size-5" /></span>
        <CardTitle className="pt-2">Won leads → ads clients</CardTitle>
        <CardDescription>
          When a lead is marked Won it is handed to the ads managers as a new client, and they get a Telegram message.
          Only the name, phone, email and niche move over, never notes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        {setting.data === undefined ? <Skeleton className="h-6 w-48" /> : (
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox checked={setting.data} disabled={pending} onCheckedChange={(v) => toggle(v === true)} />
            Hand won leads to the ads team
          </Label>
        )}
      </CardContent>
      <CardFooter>
        <Button className="w-full" variant="outline" asChild><Link href="/ads/clients">Open ads clients <ArrowRight /></Link></Button>
      </CardFooter>
    </Card>
  );
}
