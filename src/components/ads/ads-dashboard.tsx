"use client";

import { type ReactNode, useCallback, useMemo, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ExternalLink, ImageOff, Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { DataPagination } from "@/components/common/data-pagination";
import { pastPresets, RangePicker, type DayRange } from "@/components/common/range-picker";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { Bars, ChartCard, Donut, StatCard, TrendLine } from "@/components/dashboard/widgets";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { sliceGroups, useShowMore } from "@/hooks/use-show-more";
import {
  adKpis, type AdCampaignDetail, type AdCampaignRow, type AdCategory, type AdsOverview, campaignStatusLabel, formatPercent,
  formatRatio, matchCategories, moneyFormat, objectiveLabel, topWithOther,
} from "@/lib/ads";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { formatCount } from "@/lib/format";
import { cleanSearch } from "@/lib/search";
import { createClient } from "@/lib/supabase/client";
import { addDays, formatCalendarDate, formatDate, formatDayLabel, formatRelative, istToday } from "@/lib/time";
import { cn } from "@/lib/utils";
import { refreshAdAccount, setCampaignCategory } from "@/server/actions/ads";

const TOP_CAMPAIGNS = 6;

/** Which campaigns the table lists. "Ran in…": spent money on at least one of those days, paused since or not. */
const CAMPAIGN_STATUS_FILTERS = {
  active: "Running now",
  ran_7: "Ran in the last 7 days",
  ran_14: "Ran in the last 14 days",
  ran_28: "Ran in the last 28 days",
  inactive: "Not running",
  all: "Any status",
} as const;
type CampaignStatusFilter = keyof typeof CAMPAIGN_STATUS_FILTERS;
const CATEGORY_COLORS = ["#10a37f", "#38bdf8", "#a855f7", "#f59e0b", "#f43f5e", "#eab308", "#14b8a6"];

/** Uncategorised campaigns in a category selection. */
const NONE = "none";

/** Which campaigns the dashboard counts: our company (default), the whole account, or picked categories. */
type CategoryView = { kind: "ours" } | { kind: "all" } | { kind: "pick"; ids: string[] };
type AdsFilter = { p_category?: string; p_ours?: boolean; p_categories?: string[]; p_with_uncategorised?: boolean };

function viewFilter(view: CategoryView, fixedCategory?: string): AdsFilter {
  if (fixedCategory) return { p_category: fixedCategory };
  if (view.kind === "ours") return { p_ours: true };
  if (view.kind === "all") return {};
  return { p_categories: view.ids.filter((id) => id !== NONE), p_with_uncategorised: view.ids.includes(NONE) };
}

/**
 * KPIs, charts and the campaign table of one ad account. Used for a company's ads, an ads client's
 * page and the client's own read-only portal. `canManage` shows Refresh and the category pickers.
 * A new `version` refetches everything (e.g. after campaigns were filed in the categories dialog).
 * A given `range` is owned by the parent (which shows the picker); `fixedCategory` shows only that
 * category (an ads client's slice of the agency account) without the category picker.
 */
export function AdsDashboard({ accountId, canManage, version = 0, range: sharedRange, fixedCategory, syncSlot, initial }: {
  accountId: string; canManage: boolean; version?: number; range?: DayRange; fixedCategory?: string;
  /** Opens on one category ("none" = uncategorised) and these days instead of our company over 30 days. */
  initial?: { category?: string; range?: DayRange };
  /** Where the page wants the synced time and Refresh button (rendered there instead of in this toolbar); `null` while that spot mounts. */
  syncSlot?: HTMLElement | null;
}) {
  const [ownRange, setRange] = useState<DayRange>(() => initial?.range ?? { from: addDays(istToday(), -29), to: istToday() });
  const range = sharedRange ?? ownRange;
  const [view, setView] = useState<CategoryView>(() => (initial?.category ? { kind: "pick", ids: [initial.category] } : { kind: "ours" }));
  const filter = useMemo(() => viewFilter(view, fixedCategory), [view, fixedCategory]);
  // The campaign table's own categories: the same as the top filter until changed in the table.
  // Changing the top filter brings the table back in line with it.
  const [tableView, setTableView] = useState<CategoryView | null>(null);
  const tableFilter = useMemo(() => viewFilter(tableView ?? view, fixedCategory), [tableView, view, fixedCategory]);
  const changeView = (v: CategoryView) => { setView(v); setTableView(null); };
  const filterKey = JSON.stringify(filter);

  const overview = useLiveQuery({
    queryKey: `ads-overview:${accountId}:${range.from}:${range.to}:${filterKey}:${version}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient()
        .rpc("ads_overview", { p_account: accountId, p_from: range.from, p_to: range.to, ...filter }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as AdsOverview;
    },
    pollMs: 5 * 60_000,
  });
  const scope = overview.data?.account.scope;
  const categories = useLiveQuery({
    queryKey: `ads-categories:${accountId}:${version}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("ad_categories_list", { p_account: accountId }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as AdCategory[];
    },
    enabled: scope === "all",
    pollMs: 0,
  });

  const o = overview.data;
  // The per-campaign charts show the top 6; the button expands them to all returned (up to 20).
  const [allCampaigns, setAllCampaigns] = useState(false);
  const campaigns = o ? (allCampaigns ? o.campaigns : o.campaigns.slice(0, TOP_CAMPAIGNS)) : [];
  const moreCampaigns = o && o.campaigns.length > TOP_CAMPAIGNS ? (
    <Button size="sm" variant="ghost" onClick={() => setAllCampaigns((v) => !v)}>
      {allCampaigns ? `Show top ${TOP_CAMPAIGNS}` : `Show top ${o.campaigns.length}`}
    </Button>
  ) : null;
  const money = useMemo(() => moneyFormat(o?.account.currency), [o?.account.currency]);
  const moneyCompact = useMemo(() => moneyFormat(o?.account.currency, true), [o?.account.currency]);
  const dayLabel = useCallback((d: string) => formatDayLabel(d), []);
  const t = o?.totals;
  const k = t ? adKpis(t, o?.reach_month) : null;
  const rangeText = o ? `${formatCalendarDate(o.range.from)} – ${formatCalendarDate(o.range.to)}${o.account.timezone ? ` (${o.account.timezone})` : ""}` : "";

  const showCategories = scope === "all" && !fixedCategory && (categories.data?.length ?? 0) > 0;

  if (overview.error && !o) return <ErrorState message={overview.error} onRetry={overview.refetch} />;

  const syncControls = (
    <>
      {o ? <SyncStatus account={o.account} /> : null}
      {canManage && o && !o.account.archived_at ? <RefreshButton accountId={accountId} onDone={overview.refetch} /> : null}
    </>
  );

  return (
    <div className="space-y-5">
      {syncSlot ? createPortal(syncControls, syncSlot) : null}
      <div className="flex flex-wrap items-center gap-2">
        {sharedRange ? null : <RangePicker value={range} onChange={(r) => r && setRange(r)} presets={pastPresets()} ariaLabel="Ads date range" align="start" />}
        {showCategories ? <CategoryFilter categories={categories.data ?? []} value={view} onChange={changeView} /> : null}
        <FetchingIndicator show={overview.isFetching && !overview.isInitialLoading} />
        {syncSlot === undefined ? <div className="ml-auto flex items-center gap-2">{syncControls}</div> : null}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Amount spent" value={t ? money(t.spend) : null} hint={`${t ? formatCount(t.active_campaigns) : "…"} active of ${t ? formatCount(t.campaigns) : "…"} campaigns`} />
        <StatCard label="Results (leads)" value={t ? formatCount(t.leads) : null} hint={`Cost per lead: ${k?.cpl != null ? money(k.cpl) : "—"}`} />
        <StatCard label="Impressions" value={t ? formatCount(t.impressions) : null} hint={`CPM: ${k?.cpm != null ? money(k.cpm) : "—"}`} />
        <StatCard label={o?.reach_month != null ? "Reach (month, unique)" : "Reach (daily, summed)"}
          value={t ? formatCount(o?.reach_month ?? t.reach_daily_sum) : null}
          hint={o?.reach_month != null ? `Frequency: ${formatRatio(k?.frequency ?? null)}`
            : view.kind === "pick" || (view.kind === "ours" && categories.data?.some((c) => !c.in_dashboard))
              ? "Unique reach covers the whole account: pick Everything and a whole month" : "Pick a whole calendar month for unique reach"} />
        <StatCard label="Clicks" value={t ? formatCount(t.clicks) : null} hint={`CTR: ${formatPercent(k?.ctr ?? null)}`} />
        <StatCard label="Cost per click" value={k ? (k.cpc != null ? money(k.cpc) : "—") : null} hint={`Link clicks: ${t ? formatCount(t.link_clicks) : "…"}`} />
        <StatCard label="Conversions" value={t ? formatCount(t.conversions) : null} hint={`Cost each: ${k?.costPerConversion != null ? money(k.costPerConversion) : "—"}`} />
        <StatCard label="Purchase value" value={t ? money(t.conversion_value) : null} hint={`ROAS: ${k?.roas != null ? `${formatRatio(k.roas)}×` : "—"}`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Amount spent" description={`Per day · ${rangeText}`}>
          {o ? <TrendLine points={o.daily.map((d) => ({ x: d.date, y: Number(d.spend) }))} label="Spent" format={moneyCompact} dateLabel={dayLabel} /> : <ListSkeleton rows={4} />}
        </ChartCard>
        <ChartCard title="Results" description={`Leads per day · ${rangeText}`}>
          {o ? <TrendLine points={o.daily.map((d) => ({ x: d.date, y: Number(d.leads) }))} label="Leads" dateLabel={dayLabel} /> : <ListSkeleton rows={4} />}
        </ChartCard>
        <ChartCard title="Amount spent per campaign" description={`Top ${campaigns.length || TOP_CAMPAIGNS} campaigns in the range`} action={moreCampaigns}>
          {o ? (campaigns.length
            ? <Bars horizontal items={campaigns.map((c) => ({ name: c.name, value: Number(c.spend) }))} label="Spent" format={moneyCompact} />
            : <p className="py-10 text-center text-sm text-muted-foreground">No spend in this range.</p>) : <ListSkeleton rows={4} />}
        </ChartCard>
        {o?.categories ? (
          <ChartCard title="Spend by category" description="Which company or category the money went to">
            {o.categories.length
              ? <Donut items={topWithOther(o.categories.map((c) => ({ name: c.name, value: Number(c.spend) })))
                  .map((c, idx, all) => ({ ...c, color: idx === all.length - 1 && c.name.startsWith("Other (") ? "#64748b" : CATEGORY_COLORS[idx % CATEGORY_COLORS.length] }))}
                  format={moneyCompact} totalLabel="spent" />
              : <p className="py-10 text-center text-sm text-muted-foreground">No spend in this range.</p>}
          </ChartCard>
        ) : (
          <ChartCard title="Leads per campaign" description={`Top ${campaigns.length || TOP_CAMPAIGNS} campaigns by spend in the range`} action={moreCampaigns}>
            {o ? (campaigns.length
              ? <Bars horizontal items={campaigns.map((c) => ({ name: c.name, value: Number(c.leads) }))} label="Leads" />
              : <p className="py-10 text-center text-sm text-muted-foreground">No results in this range.</p>) : <ListSkeleton rows={4} />}
          </ChartCard>
        )}
      </div>

      <CampaignTable
        accountId={accountId} range={range} filter={tableFilter} money={money} version={version}
        categoryFilter={showCategories ? (
          <CategoryFilter categories={categories.data ?? []} value={tableView ?? view} onChange={setTableView}
            className="h-8 w-48" ariaLabel="Categories in the campaign table" />
        ) : null}
        categories={scope === "all" && canManage ? (categories.data ?? []) : null}
        onCategoryChanged={() => { overview.refetch(); categories.refetch(); }}
      />
    </div>
  );
}

/**
 * Multi-select of categories for the dashboard. The ticks always show what is counted: "Our company"
 * ticks every category switched on plus uncategorised; unticking or ticking one starts a custom pick.
 */
function CategoryFilter({ categories, value, onChange, className, ariaLabel = "Categories shown" }: {
  categories: AdCategory[]; value: CategoryView; onChange: (v: CategoryView) => void; className?: string; ariaLabel?: string;
}) {
  const ours = [...categories.filter((c) => c.in_dashboard).map((c) => c.id), NONE];
  const everything = [...categories.map((c) => c.id), NONE];
  const ticked = new Set(value.kind === "ours" ? ours : value.kind === "all" ? everything : value.ids);
  const same = (ids: string[], set: Set<string>) => ids.length === set.size && ids.every((id) => set.has(id));
  const toggle = (id: string) => {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id); else next.add(id);
    if (next.size === 0 || same(ours, next)) onChange({ kind: "ours" });
    else if (same(everything, next)) onChange({ kind: "all" });
    else onChange({ kind: "pick", ids: [...next] });
  };
  const [search, setSearch] = useState("");
  const label = value.kind === "ours" ? "Our company" : value.kind === "all" ? "Everything"
    : value.ids.length === 1 ? (value.ids[0] === NONE ? "Uncategorised" : categories.find((c) => c.id === value.ids[0])?.name ?? "1 category")
    : `${value.ids.length} categories`;
  const row = (id: string, name: string) => (
    <div key={id} className="group flex items-center rounded-md hover:bg-muted">
      <Label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 font-normal">
        <Checkbox checked={ticked.has(id)} onCheckedChange={() => toggle(id)} />
        <span className="min-w-0 truncate">{name}</span>
      </Label>
      {/* Just this one, without unticking the rest by hand. */}
      <button type="button" onClick={() => onChange({ kind: "pick", ids: [id] })}
        className="mr-1 shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">
        Only
      </button>
    </div>
  );
  const groups = [
    { title: "Our company", list: matchCategories(categories.filter((c) => c.in_dashboard), search) },
    { title: "Clients", list: matchCategories(categories.filter((c) => !c.in_dashboard), search) },
  ];
  // 20 rows at first, 20 more each time the list is scrolled near its end.
  const paging = useShowMore(groups[0].list.length + groups[1].list.length, search);
  const shown = sliceGroups(groups.map((g) => g.list), paging.count);
  const showNone = !search.trim() || "uncategorised".includes(search.trim().toLowerCase());
  return (
    <Popover onOpenChange={(o) => !o && setSearch("")}>
      <PopoverTrigger asChild>
        <Button variant="outline" className={cn("w-56 justify-between font-normal", className)} aria-label={ariaLabel}>
          <span className="truncate">{label}</span><ChevronDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        {/* Same look as the campaign category picker's search. */}
        <div className="relative p-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 opacity-50" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search categories" maxLength={60}
            className="h-8 rounded-lg border-input/30 bg-input/30 pl-8 shadow-none" aria-label="Search categories" />
        </div>
        <div className="grid grid-cols-2 gap-1 p-1">
          <Button size="sm" variant={value.kind === "ours" ? "secondary" : "ghost"} onClick={() => onChange({ kind: "ours" })}>Our company</Button>
          <Button size="sm" variant={value.kind === "all" ? "secondary" : "ghost"} onClick={() => onChange({ kind: "all" })}>Everything</Button>
        </div>
        <div className="max-h-80 overflow-y-auto" onScroll={paging.onScroll}>
          {groups.map((g, i) => shown[i].length ? (
            <div key={g.title} className="border-t pt-1">
              <p className="px-2 py-1 text-xs font-medium text-muted-foreground">{g.title} · {formatCount(g.list.length)}</p>
              {shown[i].map((c) => row(c.id, c.name))}
            </div>
          ) : null)}
          {paging.more ? <p className="px-2 py-1.5 text-xs text-muted-foreground">Scroll for {formatCount(paging.more)} more</p> : null}
          {!groups.some((g) => g.list.length) && !showNone ? <p className="px-2 py-3 text-center text-sm text-muted-foreground">No category matches.</p> : null}
          {showNone ? <div className="border-t pt-1">{row(NONE, "Uncategorised")}</div> : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SyncStatus({ account }: { account: AdsOverview["account"] }) {
  if (account.archived_at) return <Badge variant="outline" className="text-muted-foreground">Disconnected · history only</Badge>;
  if (account.sync_paused) return <Badge variant="outline" className="text-muted-foreground">Sync paused</Badge>;
  if (account.status === "error") return <Badge variant="outline" className="border-red-400/30 text-red-300" title={account.last_error ?? undefined}>Problem · not syncing</Badge>;
  return (
    <span className="text-xs text-muted-foreground">
      {account.last_synced_at ? `Synced ${formatRelative(account.last_synced_at)}` : "Waiting for the first sync"}
    </span>
  );
}

function RefreshButton({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
      const r = await refreshAdAccount({ accountId });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Updated from Meta");
      onDone();
    })}>
      {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Refresh now
    </Button>
  );
}

const SORTS = { spend: "Amount spent", leads: "Results", cpl: "Cost per lead", ctr: "CTR", impressions: "Impressions", created: "Newest", last_active: "Last active", name: "Name" } as const;
type Sort = keyof typeof SORTS;

function statusTone(status: string | null) {
  if (status === "ACTIVE") return "border-emerald-400/30 text-emerald-300";
  if (status === "WITH_ISSUES" || status === "DISAPPROVED") return "border-red-400/30 text-red-300";
  return "text-muted-foreground";
}

function CampaignTable({ accountId, range, filter, money, version, categories, categoryFilter, onCategoryChanged }: {
  accountId: string; range: DayRange; filter: AdsFilter; version: number;
  /** The table's own category filter, shown in its toolbar. */
  categoryFilter: ReactNode;
  money: (v: number | string | null | undefined) => string; categories: AdCategory[] | null; onCategoryChanged: () => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [input, setInput] = useState("");
  const search = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  const [status, setStatus] = useState<CampaignStatusFilter>("active");
  const [sort, setSort] = useState<Sort>("spend");
  const [openId, setOpenId] = useState<string | null>(null);
  const key = `${accountId}:${range.from}:${range.to}:${JSON.stringify(filter)}:${search}:${status}:${sort}`;
  const [pageKey, setPageKey] = useState(key);
  // Any change of filters starts again from page 1.
  if (pageKey !== key) { setPageKey(key); setPage(1); }

  const list = useLiveQuery({
    queryKey: `ads-campaigns:${key}:${page}:${pageSize}:${version}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("list_ad_campaigns", {
        p_account: accountId, p_from: range.from, p_to: range.to, ...filter,
        p_search: search || undefined, p_status: status === "all" ? undefined : status,
        p_sort: sort, p_dir: sort === "name" || sort === "cpl" ? "asc" : "desc",
        p_limit: pageSize, p_offset: (page - 1) * pageSize,
      }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as { items: AdCampaignRow[]; total: number };
    },
    pollMs: 5 * 60_000,
  });

  return (
    <Card className="gap-0 p-0">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <h2 className="mr-auto text-sm font-semibold">Campaigns</h2>
        {categoryFilter}
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search campaigns" className="h-8 w-52 pl-8" aria-label="Search campaigns" />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as CampaignStatusFilter)}>
          <SelectTrigger size="sm" className="w-48" aria-label="Which campaigns"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(CAMPAIGN_STATUS_FILTERS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
          <SelectTrigger size="sm" className="w-40" aria-label="Sort by"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(SORTS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {list.error && !list.data ? <div className="p-4"><ErrorState message={list.error} onRetry={list.refetch} /></div>
        : !list.data ? <div className="p-4"><ListSkeleton rows={5} /></div>
        : list.data.items.length === 0 ? <div className="p-4">{status !== "all" && status !== "inactive" && !search
          ? <EmptyState
              title={status === "active" ? "No running campaigns" : "No campaigns ran in that time"}
              description={status === "active" ? "None of the campaigns is running right now." : `No campaign spent money in the ${CAMPAIGN_STATUS_FILTERS[status].toLowerCase().replace("ran in the ", "")}.`}
              action={<Button size="sm" variant="outline" onClick={() => setStatus(status === "active" ? "ran_7" : "all")}>
                {status === "active" ? "Show the ones that ran in the last 7 days" : "Show all campaigns"}
              </Button>} />
          : <EmptyState title="No campaigns" description="Nothing matches, or the first sync hasn't finished yet." />}</div>
        : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-64">Campaign</TableHead>
                  {categories ? <TableHead>Category</TableHead> : null}
                  <TableHead className="text-right">Spent</TableHead>
                  <TableHead className="text-right">Results</TableHead>
                  <TableHead className="text-right">Cost / result</TableHead>
                  <TableHead className="text-right">Impressions</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead>Last active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.items.map((c) => {
                  const kp = adKpis({ ...c, conversion_value: 0 });
                  return (
                    <TableRow key={c.id} className="cursor-pointer" onClick={() => setOpenId(c.id)}>
                      <TableCell>
                        <div className="font-medium">{c.name}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <Badge variant="outline" className={cn("h-5 px-1.5 text-[11px]", statusTone(c.effective_status))}>{campaignStatusLabel(c.effective_status)}</Badge>
                          {objectiveLabel(c.objective) ? <span>{objectiveLabel(c.objective)}</span> : null}
                          {c.created_time ? <span>· Launched {formatDate(c.created_time)}</span> : null}
                          <span>· {formatCount(c.ads)} ads</span>
                        </div>
                      </TableCell>
                      {categories ? (
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <CategoryPicker campaign={c} categories={categories} onChanged={() => { list.refetch(); onCategoryChanged(); }} />
                        </TableCell>
                      ) : null}
                      <TableCell className="text-right tabular-nums">{money(c.spend)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCount(Number(c.leads))}</TableCell>
                      <TableCell className="text-right tabular-nums">{kp.cpl != null ? money(kp.cpl) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCount(Number(c.impressions))}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPercent(kp.ctr)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.last_active ? formatCalendarDate(c.last_active) : "—"}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      {list.data ? (
        <div className="px-3 pb-3">
          <DataPagination inline page={page} pageSize={pageSize} total={list.data.total} disabled={list.isFetching}
            onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
        </div>
      ) : null}
      <CampaignSheet campaignId={openId} range={range} money={money} onClose={() => setOpenId(null)} />
    </Card>
  );
}

/** Searchable, so it stays usable with hundreds of client categories (at most 50 drawn at once). */
function CategoryPicker({ campaign, categories, onChanged }: { campaign: AdCampaignRow; categories: AdCategory[]; onChanged: () => void }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const current = campaign.category?.id ?? NONE;
  const matches = matchCategories(categories, search);
  const paging = useShowMore(matches.length, search);
  const pick = (v: string) => {
    setOpen(false);
    if (v === current) return;
    start(async () => {
      const r = await setCampaignCategory({ campaignIds: [campaign.id], categoryId: v === NONE ? null : v });
      if (!r.ok) { toast.error(r.error); return; }
      onChanged();
    });
  };
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" role="combobox" aria-expanded={open} disabled={pending} className="w-44 justify-between font-normal"
          aria-label={`Category of ${campaign.name}`}>
          <span className="truncate">{campaign.category?.name ?? "Uncategorised"}</span>
          {pending ? <Loader2 className="animate-spin" /> : <ChevronDown className="opacity-50" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder="Search categories" />
          <CommandList onScroll={paging.onScroll}>
            <CommandEmpty>No category matches.</CommandEmpty>
            <CommandGroup>
              {!search.trim() || "uncategorised".includes(search.trim().toLowerCase())
                ? <CommandItem value={NONE} onSelect={pick}><Check className={cn(current !== NONE && "invisible")} /> Uncategorised</CommandItem> : null}
              {matches.slice(0, paging.count).map((c) => (
                <CommandItem key={c.id} value={c.id} onSelect={pick}>
                  <Check className={cn(current !== c.id && "invisible")} /> <span className="truncate">{c.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {paging.more ? <p className="px-3 py-2 text-xs text-muted-foreground">Scroll for {formatCount(paging.more)} more</p> : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CampaignSheet({ campaignId, range, money, onClose }: {
  campaignId: string | null; range: DayRange; money: (v: number | string | null | undefined) => string; onClose: () => void;
}) {
  const detail = useLiveQuery({
    queryKey: `ads-campaign:${campaignId}:${range.from}:${range.to}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("ad_campaign_detail", { p_campaign: campaignId!, p_from: range.from, p_to: range.to }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as AdCampaignDetail;
    },
    enabled: Boolean(campaignId),
    pollMs: 0,
  });
  const dayLabel = useCallback((d: string) => formatDayLabel(d), []);
  const d = campaignId ? detail.data : undefined;
  const c = d?.campaign;
  return (
    <Sheet open={Boolean(campaignId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{c?.name ?? "Campaign"}</SheetTitle>
          <SheetDescription>
            {c ? [campaignStatusLabel(c.effective_status), objectiveLabel(c.objective), c.created_time ? `launched ${formatDate(c.created_time)}` : null,
              c.daily_budget ? `${money(c.daily_budget)} a day` : c.lifetime_budget ? `${money(c.lifetime_budget)} lifetime` : null].filter(Boolean).join(" · ") : "Loading…"}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          {!d ? <ListSkeleton rows={6} /> : (
            <>
              <ChartCard title="Amount spent" description={`Per day · ${formatCalendarDate(range.from)} – ${formatCalendarDate(range.to)}`}>
                <TrendLine points={d.daily.map((x) => ({ x: x.date, y: Number(x.spend) }))} label="Spent" format={money} dateLabel={dayLabel} />
              </ChartCard>
              <div>
                <h3 className="mb-2 text-sm font-semibold">Ads ({d.ads.length}), newest first</h3>
                {d.ads.length === 0 ? <p className="text-sm text-muted-foreground">No ads synced yet.</p> : (
                  <ul className="divide-y rounded-lg border">
                    {d.ads.map((a) => (
                      <li key={a.id} className="flex gap-3 p-3">
                        <AdThumb url={a.thumbnail_url} />
                        <div className="min-w-0 flex-1 text-sm">
                          <div className="flex items-start justify-between gap-2">
                            <span className="font-medium break-words">{a.name}</span>
                            <Badge variant="outline" className={cn("shrink-0", statusTone(a.effective_status))}>{campaignStatusLabel(a.effective_status)}</Badge>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {a.created_time ? `Uploaded ${formatDate(a.created_time)}` : "Upload date unknown"}
                            {a.updated_time ? ` · edited ${formatDate(a.updated_time)}` : ""}
                          </p>
                          <p className="mt-1 text-xs tabular-nums">
                            {money(a.spend)} spent · {formatCount(Number(a.leads))} results · {formatCount(Number(a.impressions))} impressions · {formatCount(Number(a.clicks))} clicks
                          </p>
                          {a.preview_url ? (
                            <a href={a.preview_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs underline underline-offset-2">
                              Preview on Facebook <ExternalLink className="size-3" />
                            </a>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-muted-foreground">Per-ad numbers older than 90 days are kept as monthly totals.</p>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Meta's thumbnail links are signed and expire; fall back to a placeholder. */
function AdThumb({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return <span className="grid size-14 shrink-0 place-items-center rounded-md border bg-muted/30 text-muted-foreground"><ImageOff className="size-5" /></span>;
  }
  // eslint-disable-next-line @next/next/no-img-element -- remote, short-lived signed Meta URL; not worth image optimisation
  return <img src={url} alt="" className="size-14 shrink-0 rounded-md border object-cover" onError={() => setFailed(true)} referrerPolicy="no-referrer" />;
}
