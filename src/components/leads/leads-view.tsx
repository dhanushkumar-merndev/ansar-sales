"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Phone, Plus, Search, SlidersHorizontal, Tags, X } from "lucide-react";
import { DueBadge, StatusBadge } from "@/components/common/badges";
import { DataPagination } from "@/components/common/data-pagination";
import { PageHeader } from "@/components/common/page-header";
import { pastPresets, RangePicker } from "@/components/common/range-picker";
import { PinButton, PinnedBadge, PinnedCount, StarButton } from "@/components/common/star-pin-buttons";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { LeadFormDialog } from "@/components/leads/lead-form-dialog";
import { NicheCombobox, type NicheValue } from "@/components/leads/niche-combobox";
import { StaffSelect } from "@/components/leads/staff-select";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { LEAD_STATUSES, SEARCH_DEBOUNCE_MS, STATUS_LABELS, type LeadStatus } from "@/lib/constants";
import { lastPage, parsePaging } from "@/lib/pagination";
import { fetchLeads, type LeadQuery } from "@/lib/queries";
import { cleanSearch } from "@/lib/search";
import { formatDate, formatDateTime, formatRelative } from "@/lib/time";
import type { LeadListItem, NicheOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toggleLeadPin, toggleLeadStar } from "@/server/actions/stars";

const SORTS = ["created_at", "updated_at", "name", "status", "next_follow_up"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export function LeadsView({ initialNiches }: { initialNiches: NicheOption[] }) {
  const profile = useProfile();
  const isAdmin = profile.role === "admin";
  const router = useRouter();
  const { params, set } = useUrlState();
  const [createOpen, setCreateOpen] = useState(false);

  // Parse and sanitize URL state (the database validates again).
  const query: LeadQuery = useMemo(() => {
    const { page, pageSize } = parsePaging(params);
    const status = params.get("status");
    const sort = params.get("sort");
    const from = params.get("from");
    const to = params.get("to");
    return {
      q: cleanSearch(params.get("q")),
      status: LEAD_STATUSES.includes(status as LeadStatus) ? (status as LeadStatus) : null,
      niche: UUID_RE.test(params.get("niche") ?? "") ? params.get("niche") : null,
      owner: isAdmin && UUID_RE.test(params.get("owner") ?? "") ? params.get("owner") : null,
      ...(from && to && DATE_RE.test(from) && DATE_RE.test(to) && from <= to ? { from, to } : { from: null, to: null }),
      overdue: params.get("overdue") === "1",
      archived: isAdmin && params.get("archived") === "1",
      starred: params.get("tab") === "starred",
      sort: SORTS.includes(sort as (typeof SORTS)[number]) ? sort! : "created_at",
      dir: params.get("dir") === "asc" ? "asc" : "desc",
      page,
      pageSize,
    };
  }, [params, isAdmin]);

  // Immediate local input; URL (and the query) follow after a 300 ms debounce.
  const [searchInput, setSearchInput] = useState(query.q);
  const debounced = useDebouncedValue(cleanSearch(searchInput), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debounced !== query.q) set({ q: debounced }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  // Back/Forward: reflect the URL in the input.
  useEffect(() => {
    setSearchInput((cur) => (cleanSearch(cur) === query.q ? cur : query.q));
  }, [query.q]);

  const queryKey = `leads:${profile.id}:${JSON.stringify(query)}`;
  const { data, error, isFetching, isStale, isInitialLoading, refetch } = useLiveQuery({
    queryKey,
    fetcher: (signal) => fetchLeads(query, signal),
    tables: ["leads", "follow_ups", "niches", "lead_stars"],
  });

  // If the current page became empty (e.g. archive), move to the last valid page.
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) {
      set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
    }
  }, [data, isStale, query.page, query.pageSize, set]);

  const [nicheFilter, setNicheFilter] = useState<NicheValue>(null);
  useEffect(() => {
    if (!query.niche) setNicheFilter(null);
    else setNicheFilter((cur) => (cur?.id === query.niche ? cur : { id: query.niche!, label: initialNiches.find((n) => n.id === query.niche)?.name ?? "Selected niche" }));
  }, [query.niche, initialNiches]);

  const toggleSort = (field: string) => {
    if (query.sort === field) set({ sort: field, dir: query.dir === "asc" ? "desc" : "asc" });
    else set({ sort: field, dir: field === "name" || field === "next_follow_up" ? "asc" : "desc" });
  };

  const columns = useMemo<ColumnDef<LeadListItem>[]>(() => {
    const sortButton = (label: string, field: string) => (
      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => toggleSort(field)}>
        {label}
        {query.sort === field ? (query.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-40" />}
        <span className="sr-only">Sort by {label}</span>
      </button>
    );
    const cols: ColumnDef<LeadListItem>[] = [
      {
        id: "star",
        header: () => <span className="sr-only">Star</span>,
        cell: ({ row: { original: l } }) => (
          <div className="flex items-center">
            <StarButton id={l.id} starred={l.starred} action={toggleLeadStar} onChanged={refetch} />
            {query.starred ? <PinButton id={l.id} pinned={!!l.pinned_at} action={toggleLeadPin} onChanged={refetch} /> : null}
          </div>
        ),
      },
      {
        id: "name",
        header: function SortHeader() { return sortButton("Lead", "name"); },
        cell: ({ row: { original: l } }) => (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link href={`/leads/${l.id}`} className="font-medium hover:underline">{l.name}</Link>
              {query.starred && l.pinned_at ? <PinnedBadge /> : null}
            </div>
            <div className="truncate text-xs text-muted-foreground">{l.phone}{l.email ? ` · ${l.email}` : ""}</div>
          </div>
        ),
      },
      { id: "status", header: function SortHeader() { return sortButton("Status", "status"); }, cell: ({ row }) => <StatusBadge status={row.original.status} /> },
      { id: "niche", header: "Niche", cell: ({ row }) => <span className="text-sm">{row.original.niche.name}</span> },
    ];
    if (isAdmin) cols.push({ id: "owner", header: "Owner", cell: ({ row }) => <span className="text-sm">{row.original.owner.display_name}</span> });
    cols.push(
      {
        id: "next",
        header: function SortHeader() { return sortButton("Next follow-up", "next_follow_up"); },
        cell: ({ row: { original: l } }) =>
          l.next_follow_up_at ? (
            <div className="flex flex-col items-start gap-0.5">
              <span className={cn("text-sm", l.overdue && "font-medium text-red-700")} title={formatDateTime(l.next_follow_up_at)}>
                {formatRelative(l.next_follow_up_at)}
              </span>
              {l.overdue ? <DueBadge overdue /> : null}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          ),
      },
      { id: "created", header: function SortHeader() { return sortButton("Created", "created_at"); }, cell: ({ row }) => <span className="text-sm text-muted-foreground">{formatDate(row.original.created_at)}</span> },
    );
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, query.sort, query.dir, query.starred, refetch]);

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({ data: data?.items ?? [], columns, getCoreRowModel: getCoreRowModel(), manualPagination: true, manualSorting: true, getRowId: (r) => r.id });

  const activeFilters = [query.status, query.niche, query.owner, query.from, query.overdue || null, query.archived || null].filter(Boolean).length;

  const filters = (
    <div className="grid gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center">
      <Select value={query.status ?? "__all"} onValueChange={(v) => set({ status: v === "__all" ? null : v })}>
        <SelectTrigger className="w-full lg:w-[160px]" aria-label="Status"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">All statuses</SelectItem>
          {LEAD_STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}
        </SelectContent>
      </Select>
      <NicheCombobox
        value={nicheFilter}
        onChange={(v) => { setNicheFilter(v); set({ niche: v?.id ?? null }); }}
        initialOptions={initialNiches}
        allowCreate={false}
        placeholder="All niches"
        className="lg:w-[180px]"
      />
      {isAdmin ? <StaffSelect value={query.owner} onChange={(v) => set({ owner: v })} allowAny className="w-full lg:w-[170px]" /> : null}
      <RangePicker
        value={query.from && query.to ? { from: query.from, to: query.to } : null}
        onChange={(r) => set({ from: r?.from ?? null, to: r?.to ?? null })}
        presets={pastPresets()}
        placeholder="Any created date"
        align="start"
        ariaLabel="Created date range"
        className="w-full lg:w-auto"
      />
      <Label className="flex items-center gap-2 font-normal">
        <Checkbox checked={query.overdue} onCheckedChange={(c) => set({ overdue: c === true ? "1" : null })} /> Overdue follow-up
      </Label>
      {isAdmin ? (
        <Label className="flex items-center gap-2 font-normal">
          <Checkbox checked={query.archived} onCheckedChange={(c) => set({ archived: c === true ? "1" : null })} /> Archived
        </Label>
      ) : null}
      {activeFilters > 0 ? (
        <Button variant="ghost" size="sm" onClick={() => set({ status: null, niche: null, owner: null, from: null, to: null, overdue: null, archived: null })}>
          <X /> Clear filters
        </Button>
      ) : null}
    </div>
  );

  return (
    <>
      <PageHeader
        title="Leads"
        description={isAdmin ? "All leads across the team." : "Leads assigned to you."}
        actions={
          <>
            {isAdmin ? (
              <Button variant="outline" asChild><Link href="/leads/niches"><Tags /> Niches</Link></Button>
            ) : null}
            <Button onClick={() => setCreateOpen(true)}><Plus /> Add lead</Button>
          </>
        }
      />

      <div className="mb-3 flex items-center justify-between gap-2">
        <Tabs value={query.starred ? "starred" : "all"} onValueChange={(v) => set({ tab: v === "starred" ? "starred" : null })}>
          <TabsList>
            <TabsTrigger value="all">All leads</TabsTrigger>
            <TabsTrigger value="starred">Starred</TabsTrigger>
          </TabsList>
        </Tabs>
        {query.starred && data ? <PinnedCount count={data.pinnedCount} /> : null}
      </div>

      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search name, phone or email"
            className="pl-8"
            value={searchInput}
            maxLength={100}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search leads"
          />
        </div>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" className="lg:hidden"><SlidersHorizontal /> Filters{activeFilters ? ` (${activeFilters})` : ""}</Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[85svh] overflow-y-auto">
            <SheetHeader><SheetTitle>Filters</SheetTitle></SheetHeader>
            <div className="px-4 pb-6">{filters}</div>
          </SheetContent>
        </Sheet>
        <Select value={`${query.sort}:${query.dir}`} onValueChange={(v) => { const [s, d] = v.split(":"); set({ sort: s, dir: d }); }}>
          <SelectTrigger className="w-[170px] md:hidden" aria-label="Sort"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="created_at:desc">Newest first</SelectItem>
            <SelectItem value="created_at:asc">Oldest first</SelectItem>
            <SelectItem value="next_follow_up:asc">Next follow-up</SelectItem>
            <SelectItem value="name:asc">Name A–Z</SelectItem>
            <SelectItem value="updated_at:desc">Recently updated</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="mb-4 hidden lg:block">{filters}</div>

      <div className="mb-2 flex h-5 items-center justify-end"><FetchingIndicator show={isFetching && !isInitialLoading} /></div>

      {error && !data ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : isInitialLoading ? (
        <ListSkeleton />
      ) : data && data.total === 0 && query.starred && !query.q && !activeFilters ? (
        <EmptyState title="No starred leads" description="Tap the star on any lead to keep it here. Pin up to 10 to keep them on top." />
      ) : data && data.total === 0 ? (
        <EmptyState
          title={query.q || activeFilters ? "No leads match" : "No leads yet"}
          description={query.q || activeFilters ? "Try a different search or clear filters." : "Add your first lead to get started."}
          action={!query.q && !activeFilters ? <Button onClick={() => setCreateOpen(true)}><Plus /> Add lead</Button> : undefined}
        />
      ) : (
        <div className={cn("transition-opacity", isStale && "opacity-60")} aria-busy={isStale}>
          {/* Desktop table */}
          <Card className="hidden py-0 md:block">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id}>
                    {hg.headers.map((h) => <TableHead key={h.id}>{flexRender(h.column.columnDef.header, h.getContext())}</TableHead>)}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id} className={cn("cursor-pointer", query.starred && row.original.pinned_at && "bg-muted/40")} onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) router.push(`/leads/${row.id}`); }}>
                    {row.getVisibleCells().map((cell) => <TableCell key={cell.id} className={cn("py-2.5", cell.column.id === "star" && "w-px pr-0")}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          {/* Mobile cards */}
          <ul className="space-y-2 md:hidden">
            {data?.items.map((l) => (
              <li key={l.id} className="relative">
                <Link href={`/leads/${l.id}`} className={cn("block rounded-lg border bg-card p-3 active:bg-muted", query.starred && l.pinned_at && "bg-muted/40")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium"><span className="truncate">{l.name}</span>{query.starred && l.pinned_at ? <PinnedBadge /> : null}</p>
                      <p className="flex items-center gap-1 text-sm text-muted-foreground"><Phone className="size-3" />{l.phone}</p>
                    </div>
                    <StatusBadge status={l.status} />
                  </div>
                  <div className={cn("mt-2 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", query.starred ? "pr-[4.5rem]" : "pr-9")}>
                    <span>{l.niche.name}</span>
                    {isAdmin ? <span>{l.owner.display_name}</span> : null}
                    {l.next_follow_up_at ? (
                      <span className={cn(l.overdue && "font-medium text-red-700")}>
                        {l.overdue ? "Overdue · " : "Next · "}{formatDateTime(l.next_follow_up_at)}
                      </span>
                    ) : null}
                  </div>
                </Link>
                {/* Outside the link: buttons inside an anchor are invalid and would navigate. */}
                <div className="absolute right-1.5 bottom-1.5 flex items-center">
                  {query.starred ? <PinButton id={l.id} pinned={!!l.pinned_at} action={toggleLeadPin} onChanged={refetch} /> : null}
                  <StarButton id={l.id} starred={l.starred} action={toggleLeadStar} onChanged={refetch} />
                </div>
              </li>
            ))}
          </ul>
          {data ? (
            <DataPagination
              page={query.page}
              pageSize={query.pageSize}
              total={data.total}
              disabled={isFetching}
              onPageChange={(p) => set({ page: String(p) })}
              onPageSizeChange={(s) => set({ pageSize: String(s) })}
            />
          ) : null}
        </div>
      )}

      <LeadFormDialog open={createOpen} onOpenChange={setCreateOpen} initialNiches={initialNiches} onSaved={() => refetch()} />
    </>
  );
}
