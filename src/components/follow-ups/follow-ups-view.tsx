"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { DataPagination } from "@/components/common/data-pagination";
import { duePresets, RangePicker } from "@/components/common/range-picker";
import { ClearFiltersButton } from "@/components/common/clear-filters-button";
import { PageHeader } from "@/components/common/page-header";
import { PinnedCount } from "@/components/common/star-pin-buttons";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { FollowUpList } from "@/components/follow-ups/follow-up-list";
import { StaffSelect } from "@/components/leads/staff-select";
import { useProfile } from "@/components/providers/profile-provider";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { followUpsQueryKey, parseFollowUpQuery, type Initial, type StarredPageResult } from "@/lib/list-queries";
import { lastPage } from "@/lib/pagination";
import { fetchFollowUps, type FollowUpView } from "@/lib/queries";
import { cleanSearch } from "@/lib/search";
import type { FollowUpListItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const VIEWS: { value: FollowUpView; label: string }[] = [
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Upcoming" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "starred", label: "Starred" },
];

export function FollowUpsView({ initial }: { initial?: Initial<StarredPageResult<FollowUpListItem>> }) {
  const profile = useProfile();
  const isAdmin = profile.role === "admin";
  const { params, set } = useUrlState();
  const query = useMemo(() => parseFollowUpQuery(params, isAdmin), [params, isAdmin]);

  const [input, setInput] = useState(query.q);
  const debounced = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debounced !== query.q) set({ q: debounced }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const { data, error, isFetching, isInitialLoading, isStale, refetch } = useLiveQuery({
    queryKey: followUpsQueryKey(profile.id, query),
    fetcher: (s) => fetchFollowUps(query, s),
    tables: ["follow_ups", "leads", "follow_up_stars"],
    pollMs: 30_000, // overdue status changes with time
    keep: true,
    initial,
  });
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
  }, [data, isStale, query.page, query.pageSize, set]);

  return (
    <>
      <PageHeader title="Follow-ups" description={isAdmin ? "Team tasks. Times shown in IST." : "Your tasks. Times shown in IST."} />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Tabs value={query.view} onValueChange={(v) => set({ view: v })} className="w-full sm:w-auto shrink-0 max-w-full">
          <TabsList className="w-full sm:w-auto max-w-full overflow-x-auto no-scrollbar justify-start">
            {VIEWS.map((v) => <TabsTrigger key={v.value} value={v.value} className="shrink-0">{v.label}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <div className="relative w-full flex-1 min-w-0 sm:min-w-[200px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="h-9 pl-9 rounded-xl border-white/[0.1] bg-card/60" placeholder="Search lead or task" value={input} maxLength={100} onChange={(e) => setInput(e.target.value)} aria-label="Search follow-ups" />
        </div>
        <RangePicker
          value={query.from && query.to ? { from: query.from, to: query.to } : null}
          onChange={(r) => set({ from: r?.from ?? null, to: r?.to ?? null })}
          presets={duePresets()}
          placeholder="Any due date"
          allowFuture
          ariaLabel="Due date range"
          className="w-full sm:w-auto shrink-0"
        />
        {isAdmin ? <StaffSelect value={query.assignee} onChange={(v) => set({ assignee: v })} allowAny className="w-full sm:w-[190px]" /> : null}
        {data && data.pinnedCount > 0 ? <PinnedCount count={data.pinnedCount} /> : null}
        <ClearFiltersButton loading={isFetching && !isInitialLoading}
          show={!!(query.q || query.from || query.assignee)}
          onClear={() => { setInput(""); set({ q: null, from: null, to: null, assignee: null }); }}
        />
      </div>
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : isInitialLoading ? <ListSkeleton /> : !data?.total ? (
        <EmptyState
          title={query.view === "overdue" ? "Nothing overdue" : query.view === "starred" && !query.q ? "No starred follow-ups" : "No follow-ups here"}
          description={query.view === "today" ? "No tasks due today." : query.view === "starred" && !query.q ? "Tap the star on any task to keep it here. Pin up to 10 to keep them on top." : undefined}
        />
      ) : (
        <div className={cn(isStale && "opacity-60")}>
          <FollowUpList items={data.items} showAssignee={isAdmin} onChanged={refetch} />
          <DataPagination page={query.page} pageSize={query.pageSize} total={data.total} disabled={isFetching}
            onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s) })} />
        </div>
      )}
    </>
  );
}
