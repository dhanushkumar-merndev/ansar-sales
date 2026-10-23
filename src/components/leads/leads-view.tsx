"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, CalendarPlus, ChevronDown, FileSpreadsheet, Phone, Plus, Search, SlidersHorizontal, StickyNote, Tags, UserPlus } from "lucide-react";
import { DueBadge, StatusBadge } from "@/components/common/badges";
import { ClearFiltersButton } from "@/components/common/clear-filters-button";
import { DataPagination } from "@/components/common/data-pagination";
import { PageHeader } from "@/components/common/page-header";
import { pastPresets, RangePicker } from "@/components/common/range-picker";
import { PinButton, PinnedBadge, PinnedCount, StarButton } from "@/components/common/star-pin-buttons";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { FollowUpDialog } from "@/components/follow-ups/follow-up-dialogs";
import { CallButton } from "@/components/leads/call-button";
import { LeadNotesDialog } from "@/components/leads/call-notes";
import { ImportLeadsDialog } from "@/components/leads/import-leads-dialog";
import { LeadDownloadMenu } from "@/components/leads/lead-download-menu";
import { LeadFormDialog } from "@/components/leads/lead-form-dialog";
import { NicheCombobox, type NicheValue } from "@/components/leads/niche-combobox";
import { StageSelect } from "@/components/leads/stage-select";
import { StaffSelect } from "@/components/leads/staff-select";
import { TemperatureBadge, TemperatureSelect } from "@/components/leads/temperature-select";
import { useProfile } from "@/components/providers/profile-provider";
import { useStages } from "@/components/providers/stages-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useHiddenColumns } from "@/hooks/use-hidden-columns";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { LEAD_TEMPERATURES, SEARCH_DEBOUNCE_MS, TEMPERATURE_LABELS } from "@/lib/constants";
import { lastPage } from "@/lib/pagination";
import { leadsQueryKey, parseLeadQuery, type Initial, type StarredPageResult } from "@/lib/list-queries";
import { fetchLeads, type LeadQuery } from "@/lib/queries";
import { cleanSearch } from "@/lib/search";
import { formatDate, formatDateTime, formatRelative } from "@/lib/time";
import type { LeadListItem, NicheOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toggleLeadPin, toggleLeadStar } from "@/server/actions/stars";


/** The table's right-hand buttons; the column shows while any of them is on. */
const ACTION_BUTTONS = ["call", "follow_up", "actions"] as const;

export function LeadsView({ initialNiches, initial }: { initialNiches: NicheOption[]; initial?: Initial<StarredPageResult<LeadListItem>> }) {
  const profile = useProfile();
  const { stages } = useStages();
  const isAdmin = profile.role === "admin";
  const router = useRouter();
  const { params, set } = useUrlState();
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [notesFor, setNotesFor] = useState<{ id: string; name: string } | null>(null);
  const [followUpFor, setFollowUpFor] = useState<string | null>(null);
  const { hidden } = useHiddenColumns("leads");
  const hiddenKey = [...hidden].sort().join(",");

  // Parse and sanitize URL state (the database validates again).
  const query: LeadQuery = useMemo(() => parseLeadQuery(params, isAdmin), [params, isAdmin]);

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

  const queryKey = leadsQueryKey(profile.id, query);
  const { data, error, isFetching, isStale, isInitialLoading, refetch } = useLiveQuery({
    queryKey,
    fetcher: (signal) => fetchLeads(query, signal),
    tables: ["leads", "follow_ups", "niches", "lead_stars"],
    keep: true,
    initial,
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
            <PinButton id={l.id} pinned={!!l.pinned_at} action={toggleLeadPin} onChanged={refetch} />
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
              {l.pinned_at ? <PinnedBadge /> : null}
            </div>
            <div className="truncate text-xs text-muted-foreground">{[l.company_name, l.phone, l.email].filter(Boolean).join(" · ")}</div>
          </div>
        ),
      },
      {
        id: "temperature",
        header: "Temperature",
        // The dropdown renders in a portal, but React still bubbles its clicks to the row (which opens the lead).
        cell: ({ row: { original: l } }) => (
          <div onClick={(e) => e.stopPropagation()}>
            {l.archived_at ? <TemperatureBadge value={l.temperature} /> : <TemperatureSelect leadId={l.id} value={l.temperature} onChanged={refetch} />}
          </div>
        ),
      },
      {
        id: "status",
        header: function SortHeader() { return sortButton("Stage", "status"); },
        cell: ({ row: { original: l } }) => (
          <div onClick={(e) => e.stopPropagation()}>
            {l.archived_at ? <StatusBadge stageId={l.stage_id} status={l.status} /> : <StageSelect leadId={l.id} stageId={l.stage_id} onChanged={refetch} />}
          </div>
        ),
      },
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
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        // Call, schedule a follow-up and read notes without opening the lead; each can be hidden in Settings.
        cell: ({ row: { original: l } }) => (
          <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            {!l.archived_at && !hidden.has("call") ? <CallButton size="sm" variant="outline" leadId={l.id} phone={l.phone.replace(/\s/g, "")} leadName={l.name} onLogged={refetch} /> : null}
            {!l.archived_at && !hidden.has("follow_up") ? (
              <Button size="sm" variant="outline" onClick={() => setFollowUpFor(l.id)}><CalendarPlus /> Follow-up</Button>
            ) : null}
            {hidden.has("actions") ? null : (
              <Button size="sm" variant="outline" onClick={() => setNotesFor({ id: l.id, name: l.name })}><StickyNote /> Notes</Button>
            )}
          </div>
        ),
      },
    );
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, query.sort, query.dir, refetch, hiddenKey]);

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: data?.items ?? [], columns, getCoreRowModel: getCoreRowModel(), manualPagination: true, manualSorting: true, getRowId: (r) => r.id,
    // The buttons column goes only when all three of its buttons are hidden.
    state: { columnVisibility: { ...Object.fromEntries([...hidden].map((id) => [id, false])), actions: !ACTION_BUTTONS.every((b) => hidden.has(b)) } },
  });

  const activeFilters = [query.stage, query.temperature, query.niche, query.owner, query.from, query.overdue || null, query.archived || null].filter(Boolean).length;
  const clearAll = () => {
    setSearchInput("");
    set({ q: null, stage: null, temp: null, niche: null, owner: null, from: null, to: null, overdue: null, archived: null });
  };
  const fetching = isFetching && !isInitialLoading;

  const datePicker = (
    <RangePicker
      value={query.from && query.to ? { from: query.from, to: query.to } : null}
      onChange={(r) => set({ from: r?.from ?? null, to: r?.to ?? null })}
      presets={pastPresets()}
      placeholder="Any created date"
      align="start"
      ariaLabel="Created date range"
      className="w-full lg:w-auto"
    />
  );

  const filters = (
    <div className="grid gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center">
      <Select value={query.stage ?? "__all"} onValueChange={(v) => set({ stage: v === "__all" ? null : v })}>
        <SelectTrigger className="w-full lg:w-[160px]" aria-label="Stage"><SelectValue placeholder="All stages" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">All stages</SelectItem>
          {stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Select value={query.temperature ?? "__all"} onValueChange={(v) => set({ temp: v === "__all" ? null : v })}>
        <SelectTrigger className="w-full lg:w-[170px]" aria-label="Temperature"><SelectValue placeholder="All temperatures" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">All temperatures</SelectItem>
          {LEAD_TEMPERATURES.map((t) => <SelectItem key={t} value={t}>{TEMPERATURE_LABELS[t]}</SelectItem>)}
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
      {/* On desktop the date picker sits in the page header. */}
      <div className="lg:hidden">{datePicker}</div>
      {/* Kept together so Clear and the spinner never wrap onto a line of their own. */}
      <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:flex-nowrap">
        <Label className="flex items-center gap-2 font-normal whitespace-nowrap">
          <Checkbox checked={query.overdue} onCheckedChange={(c) => set({ overdue: c === true ? "1" : null })} /> Overdue follow-up
        </Label>
        {isAdmin ? (
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox checked={query.archived} onCheckedChange={(c) => set({ archived: c === true ? "1" : null })} /> Archived
          </Label>
        ) : null}
        <ClearFiltersButton show={activeFilters > 0 || !!query.q} loading={fetching} onClear={clearAll} />
      </div>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Leads"
        description={isAdmin ? "All leads across the team." : "Leads assigned to you."}
        actions={
          <>
            <div className="hidden lg:block">{datePicker}</div>
            {isAdmin ? (
              <>
                <LeadDownloadMenu />
                <Button variant="outline" asChild><Link href="/leads/niches"><Tags /> Niches</Link></Button>
              </>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button><Plus /> Add lead <ChevronDown className="opacity-70" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => setCreateOpen(true)}><UserPlus /> One lead</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setImportOpen(true)}><FileSpreadsheet /> Import from Excel</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={query.starred ? "starred" : "all"} onValueChange={(v) => set({ tab: v === "starred" ? "starred" : null })} className="shrink-0">
          <TabsList>
            <TabsTrigger value="all">All leads</TabsTrigger>
            <TabsTrigger value="starred">Starred</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full min-w-0 flex-1 sm:min-w-[200px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search name, company, phone or email"
            className="h-9 rounded-xl border-white/[0.1] bg-card/60 pl-9"
            value={searchInput}
            maxLength={100}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search leads"
          />
        </div>
        <div className="hidden lg:contents">{filters}</div>
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
        {data && data.pinnedCount > 0 ? <PinnedCount count={data.pinnedCount} /> : null}
        <span className="lg:hidden"><FetchingIndicator show={fetching} /></span>
      </div>

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
                  <TableRow key={row.id} className={cn("cursor-pointer", row.original.pinned_at && "bg-muted/40")} onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button,[data-no-row-click]")) router.push(`/leads/${row.id}`); }}>
                    {row.getVisibleCells().map((cell) => <TableCell key={cell.id} data-no-row-click={cell.column.id === "star" || cell.column.id === "temperature" || cell.column.id === "status" || cell.column.id === "actions" || undefined} className={cn("py-2.5", cell.column.id === "star" && "w-px cursor-default pr-0", cell.column.id === "actions" && "w-px text-right")}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          {/* Mobile cards */}
          <ul className="space-y-2 md:hidden">
            {data?.items.map((l) => (
              <li key={l.id} className="relative">
                <Link href={`/leads/${l.id}`} className={cn("block rounded-lg border bg-card p-3 active:bg-muted", l.pinned_at && "bg-muted/40")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium"><span className="truncate">{l.name}</span>{l.pinned_at ? <PinnedBadge /> : null}</p>
                      {l.company_name ? <p className="truncate text-sm text-muted-foreground">{l.company_name}</p> : null}
                      <p className="flex items-center gap-1 text-sm text-muted-foreground"><Phone className="size-3" />{l.phone}</p>
                    </div>
                    {hidden.has("status") ? null : <StatusBadge stageId={l.stage_id} status={l.status} />}
                  </div>
                  <div className={cn("mt-2 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground", "pr-[4.5rem]")}>
                    {hidden.has("niche") ? null : <span>{l.niche.name}</span>}
                    {isAdmin && !hidden.has("owner") ? <span>{l.owner.display_name}</span> : null}
                    {l.next_follow_up_at && !hidden.has("next") ? (
                      <span className={cn(l.overdue && "font-medium text-red-700")}>
                        {l.overdue ? "Overdue · " : "Next · "}{formatDateTime(l.next_follow_up_at)}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 h-7" aria-hidden />
                </Link>
                {hidden.has("temperature") ? null : (
                  <div className="absolute bottom-2.5 left-3">
                    {l.archived_at ? <TemperatureBadge value={l.temperature} /> : <TemperatureSelect leadId={l.id} value={l.temperature} onChanged={refetch} />}
                  </div>
                )}
                {/* Outside the link: buttons inside an anchor are invalid and would navigate. */}
                <div className="absolute right-1.5 bottom-1.5 flex items-center">
                  {!l.archived_at && !hidden.has("call") ? <CallButton size="icon-sm" variant="ghost" iconOnly leadId={l.id} phone={l.phone.replace(/\s/g, "")} leadName={l.name} onLogged={refetch} /> : null}
                  {!l.archived_at && !hidden.has("follow_up") ? (
                    <Button size="icon-sm" variant="ghost" aria-label={`Schedule a follow-up for ${l.name}`} onClick={() => setFollowUpFor(l.id)}><CalendarPlus /></Button>
                  ) : null}
                  {hidden.has("actions") ? null : (
                    <Button size="icon-sm" variant="ghost" aria-label={`Notes for ${l.name}`} onClick={() => setNotesFor({ id: l.id, name: l.name })}><StickyNote /></Button>
                  )}
                  <PinButton id={l.id} pinned={!!l.pinned_at} action={toggleLeadPin} onChanged={refetch} />
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
      <FollowUpDialog open={!!followUpFor} onOpenChange={(o) => !o && setFollowUpFor(null)} leadId={followUpFor ?? undefined} onDone={refetch} />
      {notesFor ? <LeadNotesDialog leadId={notesFor.id} leadName={notesFor.name} open onOpenChange={(o) => !o && setNotesFor(null)} /> : null}
      <ImportLeadsDialog open={importOpen} onOpenChange={setImportOpen} initialNiches={initialNiches} onImported={() => refetch()} />
    </>
  );
}
