"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { AdsTabs } from "@/components/ads/ads-view";
import { PageHeader } from "@/components/common/page-header";
import { pastPresets, RangePicker, type DayRange } from "@/components/common/range-picker";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLiveQuery } from "@/hooks/use-live-query";
import { type AdAccount, type AdCategory, type AdsOverview, moneyFormat } from "@/lib/ads";
import { formatCount } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { addDays, istToday } from "@/lib/time";
import { syncMetaLeads, type SyncDays } from "@/server/actions/meta";

/** Uncategorised campaigns, as the dashboard's category filter names them. */
const NONE = "none";

type CompanyRow = { id: string; name: string; campaigns: number | null; spend: number; leads: number };

/**
 * Our own companies on the ad account (categories counted in the dashboard), each with its spend and
 * results for the range. A row opens the dashboard showing just that company.
 */
export function AdsCompaniesView() {
  const profile = useProfile();
  const router = useRouter();
  const [range, setRange] = useState<DayRange>(() => ({ from: addDays(istToday(), -29), to: istToday() }));
  const [picked, setPicked] = useState<string | null>(null);
  const [syncing, startSync] = useTransition();
  // Pulls our Facebook lead forms' leads of the period; each new lead goes to the CRM of the company
  // whose category its campaign is in (ours when uncategorised). Leads already in a CRM are skipped.
  const syncLeads = (days: SyncDays) => startSync(async () => {
    const r = await syncMetaLeads({ companyId: profile.company.id, days });
    if (!r.ok) { toast.error(r.error); return; }
    const { found, created, failed, companies } = r.data;
    toast.success(created ? `${formatCount(created)} new lead${created === 1 ? "" : "s"} from Facebook` : "No new Facebook leads", {
      description: (
        <>
          {companies.length ? <p>{companies.map((c) => `${c.name}: ${formatCount(c.created)}`).join(" · ")}</p> : null}
          <p>Checked {formatCount(found)} from the last {days} days{failed ? `, ${formatCount(failed)} failed` : ""}.</p>
        </>
      ),
    });
  });

  const accounts = useLiveQuery({
    queryKey: `ads-accounts:${profile.company.id}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("ads_accounts_for_me").abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as unknown as AdAccount[];
    },
    pollMs: 5 * 60_000,
  });
  // Only whole-account viewers see the account's categories.
  const list = (accounts.data ?? []).filter((a) => a.scope === "all");
  const current = list.find((a) => a.id === picked) ?? list[0];

  const overview = useLiveQuery({
    queryKey: `ads-companies:${current?.id}:${range.from}:${range.to}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient()
        .rpc("ads_overview", { p_account: current!.id, p_from: range.from, p_to: range.to, p_ours: true }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as AdsOverview;
    },
    enabled: Boolean(current),
    pollMs: 5 * 60_000,
  });
  const categories = useLiveQuery({
    queryKey: `ads-categories:${current?.id}:0`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("ad_categories_list", { p_account: current!.id }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as AdCategory[];
    },
    enabled: Boolean(current),
    pollMs: 0,
  });

  const o = overview.data;
  const money = moneyFormat(o?.account.currency);
  // Every company of ours is listed, also those without spend in the range; uncategorised only when it spent.
  const totals = new Map((o?.categories ?? []).map((c) => [c.id ?? NONE, c]));
  const rows: CompanyRow[] = [
    ...(categories.data ?? []).filter((c) => c.in_dashboard).map((c) => ({
      id: c.id, name: c.name, campaigns: c.campaigns, spend: Number(totals.get(c.id)?.spend ?? 0), leads: Number(totals.get(c.id)?.leads ?? 0),
    })).sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name)),
    ...(totals.has(NONE) ? [{ id: NONE, name: "Uncategorised", campaigns: null, spend: Number(totals.get(NONE)!.spend), leads: Number(totals.get(NONE)!.leads) }] : []),
  ];
  const sum = rows.reduce((t, r) => ({ spend: t.spend + r.spend, leads: t.leads + r.leads }), { spend: 0, leads: 0 });
  const open = (id: string) => current && router.push(`/ads?${new URLSearchParams({ account: current.id, category: id, from: range.from, to: range.to })}`);
  const cpl = (spend: number, leads: number) => (leads > 0 ? money(spend / leads) : "—");
  const loading = !accounts.data || (current && (!o || !categories.data));

  return (
    <>
      <PageHeader
        title="Ads"
        description={`Ad results of each of our companies on ${current?.name ?? "the ad account"}.`}
        actions={list.length > 1 && current ? (
          <Select value={current.id} onValueChange={setPicked}>
            <SelectTrigger className="w-64" aria-label="Ad account"><SelectValue /></SelectTrigger>
            <SelectContent>
              {list.map((a) => <SelectItem key={a.id} value={a.id}>{a.name ?? `act_${a.act_id}`}{a.archived_at ? " · disconnected" : ""}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
      />
      <AdsTabs />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <RangePicker value={range} onChange={(r) => r && setRange(r)} presets={pastPresets()} ariaLabel="Date range" align="start" />
        <FetchingIndicator show={overview.isFetching && !overview.isInitialLoading} />
        {profile.isSuperAdmin ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="ml-auto h-9" disabled={syncing}>
                {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync leads <ChevronDown className="opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                New Facebook leads go to the company of their campaign&apos;s category. Leads already in a CRM are skipped.
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => syncLeads(7)}>Last 7 days</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => syncLeads(30)}>Last 30 days</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => syncLeads(90)}>All (90 days, everything Meta keeps)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {accounts.error && !accounts.data ? <ErrorState message={accounts.error} onRetry={accounts.refetch} />
        : overview.error && !o ? <ErrorState message={overview.error} onRetry={overview.refetch} />
        : loading ? <ListSkeleton rows={6} />
        : !current ? <EmptyState title="No ad account of ours" description="Connect this company's Meta ad account on the Ad account tab." />
        : rows.length === 0 ? <EmptyState title="No companies yet" description="Add a category for each company under Categories on the Ad account tab and switch on “Our company”." />
        : (
          <Card className="gap-0 overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[40%] min-w-48 pl-4">Company</TableHead>
                  <TableHead className="w-[12%] text-right">Campaigns</TableHead>
                  <TableHead className="w-[18%] text-right">Spent</TableHead>
                  <TableHead className="w-[12%] text-right">Results</TableHead>
                  <TableHead className="w-[18%] pr-4 text-right">Cost / result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) open(r.id); }}>
                    <TableCell className="pl-4">
                      <Link href={`/ads?${new URLSearchParams({ account: current.id, category: r.id, from: range.from, to: range.to })}`} className="font-medium hover:underline">{r.name}</Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{r.campaigns === null ? "—" : formatCount(r.campaigns)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.spend)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(r.leads)}</TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">{cpl(r.spend, r.leads)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="pl-4 font-medium">Total</TableCell>
                  <TableCell />
                  <TableCell className="text-right font-medium tabular-nums">{money(sum.spend)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatCount(sum.leads)}</TableCell>
                  <TableCell className="pr-4 text-right font-medium tabular-nums">{cpl(sum.spend, sum.leads)}</TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </Card>
        )}
    </>
  );
}
