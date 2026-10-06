"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { pastPresets, RangePicker, type DayRange } from "@/components/common/range-picker";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { Bars, ChartCard, Donut, MultiLine, StatCard } from "@/components/dashboard/widgets";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { seriesColor } from "@/components/charts/chart";
import { useLiveQuery } from "@/hooks/use-live-query";
import { moneyFormat } from "@/lib/ads";
import { formatCount } from "@/lib/format";
import { stageHex } from "@/lib/stages";
import { createClient } from "@/lib/supabase/client";
import { addDays, formatCalendarDate, formatDayLabel, istToday } from "@/lib/time";

type Insights = {
  range: { from: string; to: string; days: number };
  totals: { received: number; created: number; duplicate: number; failed: number; open: number; won: number; lost: number; spend: number | null; currency: string | null };
  daily: { date: string; created: number; duplicate: number; failed: number }[];
  forms: { name: string; leads: number; won: number }[];
  campaigns: { campaign_id: string | null; name: string; leads: number; won: number; spend: number | null; cpl: number | null; cost_per_won: number | null }[];
  ads: { name: string; leads: number; won: number }[];
  owners: { id: string | null; name: string; leads: number; open: number; won: number; lost: number }[];
  stages: { id: string; name: string; kind: string; color: string; count: number }[];
};

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

/** Facebook Lead Ads in depth: volume, forms, campaigns (with spend when the ad account is connected), owners and outcomes. */
export function LeadAdsInsights() {
  const profile = useProfile();
  const [range, setRange] = useState<DayRange>(() => ({ from: addDays(istToday(), -29), to: istToday() }));
  const q = useLiveQuery({
    queryKey: `lead-ads-insights:${profile.company.id}:${range.from}:${range.to}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient()
        .rpc("meta_lead_insights", { p_company_id: profile.company.id, p_from: range.from, p_to: range.to }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as Insights;
    },
    tables: ["leads"],
  });
  const dayLabel = useCallback((d: string) => formatDayLabel(d), []);
  const d = q.data;
  const t = d?.totals;
  const money = moneyFormat(t?.currency);
  const rangeText = d ? `${formatCalendarDate(d.range.from)} – ${formatCalendarDate(d.range.to)} (IST)` : "";
  const closed = t ? Number(t.won) + Number(t.lost) : 0;

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2"><Link href="/automation"><ArrowLeft /> Automation</Link></Button>
      <PageHeader
        title="Facebook Lead Ads insights"
        description={`Leads from ${profile.company.name}'s Facebook and Instagram lead forms, and what became of them.`}
        actions={<>
          <FetchingIndicator show={q.isFetching && !q.isInitialLoading} />
          <RangePicker value={range} onChange={(r) => r && setRange(r)} presets={pastPresets()} ariaLabel="Insights date range" />
        </>}
      />
      {q.error && !d ? <ErrorState message={q.error} onRetry={q.refetch} /> : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="New leads" value={t ? formatCount(Number(t.created)) : null} hint={`${t ? formatCount(Number(t.received)) : "…"} form submissions in total`} />
            <StatCard label="Repeat submissions" value={t ? formatCount(Number(t.duplicate)) : null} hint="Same phone as an existing lead; noted on it" />
            <StatCard label="Won" value={t ? formatCount(Number(t.won)) : null} tone="success" hint={`Win rate (won ÷ closed): ${t ? pct(Number(t.won), closed) : "…"}`} />
            <StatCard label="Failed" value={t ? formatCount(Number(t.failed)) : null} tone={t && Number(t.failed) > 0 ? "danger" : undefined} hint="No valid phone, or Meta error" />
            <StatCard label="Ad spend on these campaigns" value={t ? (t.spend != null ? money(t.spend) : "—") : null} hint={t?.spend == null ? "Connect Facebook Ads to see spend" : "From the synced ad account"} />
            <StatCard label="Cost per lead" value={t ? (t.spend != null && Number(t.created) > 0 ? money(Number(t.spend) / Number(t.created)) : "—") : null} hint="Spend ÷ new leads" />
            <StatCard label="Cost per won lead" value={t ? (t.spend != null && Number(t.won) > 0 ? money(Number(t.spend) / Number(t.won)) : "—") : null} hint="Spend ÷ won" />
            <StatCard label="Still open" value={t ? formatCount(Number(t.open)) : null} hint={`${t ? formatCount(Number(t.lost)) : "…"} lost`} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <ChartCard title="Leads per day" description={rangeText}>
              {d ? <MultiLine categories={d.daily.map((x) => dayLabel(x.date))} series={[
                { name: "New", values: d.daily.map((x) => Number(x.created)) },
                { name: "Repeat", values: d.daily.map((x) => Number(x.duplicate)) },
                { name: "Failed", values: d.daily.map((x) => Number(x.failed)) },
              ]} /> : <ListSkeleton rows={4} />}
            </ChartCard>
            <ChartCard title="By form" description="Submissions per lead form">
              {d ? (d.forms.length ? <Donut items={d.forms.map((f) => ({ name: f.name, value: Number(f.leads), color: seriesColor(f.name) }))} totalLabel="leads" />
                : <p className="py-10 text-center text-sm text-muted-foreground">No leads in this range.</p>) : <ListSkeleton rows={4} />}
            </ChartCard>
            <ChartCard title="Where they are now" description="Current pipeline stage of these leads">
              {d ? (d.stages.length ? <Donut items={d.stages.map((s) => ({ name: s.name, value: Number(s.count), color: stageHex(s.color) }))} totalLabel="leads" />
                : <p className="py-10 text-center text-sm text-muted-foreground">No leads in this range.</p>) : <ListSkeleton rows={4} />}
            </ChartCard>
            <ChartCard title="By ad" description="New leads per ad (top 15)">
              {d ? (d.ads.length ? <Bars horizontal items={d.ads.map((a) => ({ name: a.name, value: Number(a.leads) }))} label="Leads" />
                : <p className="py-10 text-center text-sm text-muted-foreground">No leads in this range.</p>) : <ListSkeleton rows={4} />}
            </ChartCard>
          </div>
          <Card className="gap-0 overflow-x-auto p-0">
            <h2 className="border-b p-3 text-sm font-semibold">Campaigns</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-56">Campaign</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Won</TableHead>
                  <TableHead className="text-right">Spent</TableHead>
                  <TableHead className="text-right">Cost / lead</TableHead>
                  <TableHead className="text-right">Cost / won</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!d ? null : d.campaigns.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">No leads in this range.</TableCell></TableRow>
                ) : d.campaigns.map((c) => (
                  <TableRow key={`${c.campaign_id}:${c.name}`}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(Number(c.leads))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(Number(c.won))}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.spend != null ? money(c.spend) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.cpl != null ? money(c.cpl) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.cost_per_won != null ? money(c.cost_per_won) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <Card className="gap-0 overflow-x-auto p-0">
            <h2 className="border-b p-3 text-sm font-semibold">Who got them</h2>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Owner</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Won</TableHead>
                  <TableHead className="text-right">Lost</TableHead>
                  <TableHead className="text-right">Win rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!d ? null : d.owners.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">No leads in this range.</TableCell></TableRow>
                ) : d.owners.map((o) => (
                  <TableRow key={o.id ?? "none"}>
                    <TableCell className="font-medium">{o.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(Number(o.leads))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(Number(o.open))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(Number(o.won))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(Number(o.lost))}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(Number(o.won), Number(o.won) + Number(o.lost))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}
