"use client";

import { useMemo, useState } from "react";
import { MapPin, Plus } from "lucide-react";
import { DataPagination } from "@/components/common/data-pagination";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { ScheduleVisitDialog, VisitSheet, VisitStatusBadge } from "@/components/projects/site-visits/visit-dialogs";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLiveQuery } from "@/hooks/use-live-query";
import { fetchSiteVisits, type VisitView } from "@/lib/project-queries";
import { formatDateTime, formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

const VIEWS: Record<Exclude<VisitView, "all">, string> = { today: "Today", upcoming: "Upcoming", past: "Done" };

/** Visits as cards (phone-friendly), for the Site visits page or one project / lead. */
export function SiteVisitsList({ projectId, leadId, canSchedule, scheduleTitle, defaultMine = false }: {
  projectId?: string; leadId?: string; canSchedule?: boolean; scheduleTitle?: string; defaultMine?: boolean;
}) {
  const me = useProfile();
  const [view, setView] = useState<Exclude<VisitView, "all">>(projectId || leadId ? "upcoming" : "today");
  const [mine, setMine] = useState(defaultMine);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const query = useMemo(() => ({ view, mine, projectId, leadId, page, pageSize }), [view, mine, projectId, leadId, page, pageSize]);
  const list = useLiveQuery({ queryKey: `visits:${me.id}:${JSON.stringify(query)}`, fetcher: (s) => fetchSiteVisits(query, s), tables: ["site_visits", "projects"] });
  const [openId, setOpenId] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const open = list.data?.items.find((v) => v.id === openId) ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={view} onValueChange={(v) => { setView(v as typeof view); setPage(1); }}>
          <TabsList>{(Object.keys(VIEWS) as (keyof typeof VIEWS)[]).map((v) => <TabsTrigger key={v} value={v}>{VIEWS[v]}</TabsTrigger>)}</TabsList>
        </Tabs>
        {!projectId && !leadId ? (
          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm"><Checkbox checked={mine} onCheckedChange={(v) => { setMine(v === true); setPage(1); }} />Only mine</label>
        ) : null}
        <FetchingIndicator show={list.isFetching && !list.isInitialLoading} />
        <span className="flex-1" />
        {canSchedule ? <Button size="sm" onClick={() => setScheduling(true)}><Plus /> Schedule visit</Button> : null}
      </div>
      {list.error && !list.data ? <ErrorState message={list.error} onRetry={list.refetch} /> : list.isInitialLoading ? <ListSkeleton rows={3} /> : !list.data?.total ? (
        <EmptyState title={view === "today" ? "No visits today" : view === "upcoming" ? "No visits planned" : "No visits yet"} />
      ) : (
        <div className={cn("space-y-2", list.isStale && "opacity-60")}>
          {list.data.items.map((v) => (
            <button key={v.id} type="button" className="block w-full text-left" onClick={() => setOpenId(v.id)}>
              <Card className={cn("py-0 transition-colors hover:bg-accent/30", v.status === "checked_in" && "border-amber-400/40", v.overdue && "border-red-400/40")}>
                <CardContent className="flex items-start gap-3 p-4">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted"><MapPin className="size-4" /></span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{v.project?.name ?? v.lead?.name ?? "Visit"}</span>
                      <VisitStatusBadge status={v.status} overdue={v.overdue} />
                    </div>
                    <div className="text-sm text-muted-foreground">{v.purpose}</div>
                    <div className="text-xs text-muted-foreground">{formatDateTime(v.scheduled_at)} · {formatRelative(v.scheduled_at)} · {v.assignee.display_name}</div>
                    {v.project?.site_address ? <div className="truncate text-xs text-muted-foreground">{v.project.site_address}</div> : null}
                  </div>
                </CardContent>
              </Card>
            </button>
          ))}
          <DataPagination page={page} pageSize={pageSize} total={list.data.total} disabled={list.isFetching} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
        </div>
      )}
      <VisitSheet visit={open} onClose={() => setOpenId(null)} onChanged={list.refetch} />
      {canSchedule ? (
        <ScheduleVisitDialog projectId={projectId} leadId={leadId} title={scheduleTitle ?? "Plan a visit"} open={scheduling} onOpenChange={setScheduling} onDone={list.refetch} />
      ) : null}
    </div>
  );
}
