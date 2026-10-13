"use client";

import { useState } from "react";
import { AdsDashboard } from "@/components/ads/ads-dashboard";
import { pastPresets, RangePicker, type DayRange } from "@/components/common/range-picker";
import { ErrorState, FetchingIndicator } from "@/components/common/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveQuery } from "@/hooks/use-live-query";
import { adKpis, type AdsClientSummary, moneyFormat } from "@/lib/ads";
import { formatCount } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { addDays, formatCalendarDate, istToday } from "@/lib/time";
import { cn } from "@/lib/utils";

/** One place an ads client's results come from: a category of the agency account, or the client's own account. */
export type ResultSource = { accountId: string; categoryId: string | null; label: string };

const sourceKey = (s: { accountId: string; categoryId: string | null }) => `${s.accountId}:${s.categoryId ?? ""}`;

/**
 * An ads client's results across its sources: with two or more, a combined summary (added up per
 * currency only) and each source's share; below, the full dashboard of the chosen source.
 * Used on the client's page (ads team) and in the client's own portal.
 */
export const defaultRange = (): DayRange => ({ from: addDays(istToday(), -29), to: istToday() });

/** Pass `range` when the page shows the date picker itself (see `AdsClientDetail`); otherwise it sits above the results. */
export function ClientResults({ clientId, sources, canManage, range: outerRange, syncSlot }: { clientId: string; sources: ResultSource[]; canManage: boolean; range?: DayRange; syncSlot?: HTMLElement | null }) {
  const [ownRange, setRange] = useState<DayRange>(defaultRange);
  const range = outerRange ?? ownRange;
  const [picked, setPicked] = useState<string | null>(null);
  const shown = sources.find((s) => sourceKey(s) === picked) ?? sources[0];
  const several = sources.length > 1;

  return (
    <div className="space-y-4">
      <div className={cn("flex flex-wrap items-center justify-end gap-2", outerRange && !several && "hidden")}>
        {several ? (
          <Select value={sourceKey(shown)} onValueChange={setPicked}>
            <SelectTrigger className="mr-auto w-80 max-w-full" aria-label="Ad source"><SelectValue /></SelectTrigger>
            <SelectContent>{sources.map((s) => <SelectItem key={sourceKey(s)} value={sourceKey(s)}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
        ) : null}
        {outerRange ? null : <RangePicker value={range} onChange={(r) => r && setRange(r)} presets={pastPresets()} ariaLabel="Ads date range" align="end" />}
      </div>
      {several ? <CombinedSummary clientId={clientId} range={range} sources={sources} /> : null}
      <AdsDashboard key={sourceKey(shown)} accountId={shown.accountId} canManage={canManage} range={range} fixedCategory={shown.categoryId ?? undefined} syncSlot={syncSlot} />
    </div>
  );
}

function CombinedSummary({ clientId, range, sources }: { clientId: string; range: DayRange; sources: ResultSource[] }) {
  const summary = useLiveQuery({
    queryKey: `ads-client-summary:${clientId}:${range.from}:${range.to}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient()
        .rpc("ads_client_summary", { p_client: clientId, p_from: range.from, p_to: range.to }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as AdsClientSummary;
    },
    pollMs: 5 * 60_000,
  });
  const s = summary.data;
  const labels = new Map(sources.map((x) => [sourceKey(x), x.label]));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          All sources together
          <FetchingIndicator show={summary.isFetching && !summary.isInitialLoading} />
        </CardTitle>
        <CardDescription>
          {formatCalendarDate(range.from)} – {formatCalendarDate(range.to)}. Each source&apos;s own numbers, added up; different currencies are kept apart.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {summary.error && !s ? <ErrorState message={summary.error} onRetry={summary.refetch} />
          : !s ? <p className="text-sm text-muted-foreground">Loading…</p>
          : (
            <>
              {s.totals.map((t) => {
                const money = moneyFormat(t.currency);
                const k = adKpis({ ...t, conversion_value: 0 });
                return (
                  <dl key={t.currency ?? "none"} className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    <Figure label={s.totals.length > 1 ? `Spent (${t.currency ?? "?"})` : "Spent"} value={money(t.spend)} />
                    <Figure label="Results (leads)" value={formatCount(Number(t.leads))} />
                    <Figure label="Cost per result" value={k.cpl != null ? money(k.cpl) : "—"} />
                    <Figure label="Clicks" value={formatCount(Number(t.clicks))} />
                    <Figure label="Impressions" value={formatCount(Number(t.impressions))} />
                  </dl>
                );
              })}
              <ul className="divide-y rounded-lg border text-sm">
                {s.sources.map((x) => {
                  const key = sourceKey({ accountId: x.account_id, categoryId: x.category_id });
                  const total = s.totals.find((t) => t.currency === x.currency);
                  const share = total && Number(total.spend) > 0 ? Math.round((Number(x.spend) / Number(total.spend)) * 100) : null;
                  return (
                    <li key={key} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate">{labels.get(key) ?? (x.source === "agency" ? "Our ad account" : "Client's ad account")}</span>
                      <span className="tabular-nums">{moneyFormat(x.currency)(x.spend)}{share != null ? <span className="text-muted-foreground"> · {share}%</span> : null}</span>
                      <span className="text-muted-foreground tabular-nums">{formatCount(Number(x.leads))} results</span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
