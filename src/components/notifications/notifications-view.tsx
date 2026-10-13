"use client";

import { useEffect } from "react";
import Link from "next/link";
import { CheckCheck, Settings } from "lucide-react";
import { toast } from "sonner";
import { NotificationRow, useOpenNotification } from "@/components/app/notification-bell";
import { DataPagination } from "@/components/common/data-pagination";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { notificationDay, type AppNotification } from "@/lib/app-notifications";
import { lastPage, parsePaging } from "@/lib/pagination";
import { fetchMyNotifications } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { markNotificationsRead } from "@/server/actions/telegram";

/** Every notification of the signed-in person, newest first, grouped by day (IST). */
export function NotificationsView() {
  const me = useProfile();
  const open = useOpenNotification();
  const { params, set } = useUrlState();
  const unreadOnly = params.get("show") === "unread";
  const { page, pageSize } = parsePaging(params);
  const q = useLiveQuery({
    queryKey: `notifications:${me.id}:${unreadOnly}:${page}:${pageSize}`,
    fetcher: (s) => fetchMyNotifications({ unread: unreadOnly, page, pageSize }, s), tables: ["app_notifications"],
  });
  const data = q.data;
  useEffect(() => {
    if (data && !q.isStale && !data.items.length && data.total > 0 && page > 1) set({ page: String(lastPage(data.total, pageSize)) }, { replace: true });
  }, [data, q.isStale, page, pageSize, set]);

  const readAll = async () => {
    const r = await markNotificationsRead({});
    if (!r.ok) return void toast.error(r.error);
    q.refetch();
  };

  // Day headings within the page.
  const groups: { day: string; items: AppNotification[] }[] = [];
  for (const n of data?.items ?? []) {
    const day = notificationDay(n.created_at);
    if (groups.at(-1)?.day === day) groups.at(-1)!.items.push(n); else groups.push({ day, items: [n] });
  }

  return (
    <>
      <PageHeader title="Notifications" description="Everything the CRM told you about, newest first."
        actions={<Button asChild variant="outline"><Link href="/settings"><Settings /> Choose what you get</Link></Button>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border p-0.5" role="tablist" aria-label="Show">
          {([["all", "All"], ["unread", `Unread${data?.unread ? ` (${data.unread})` : ""}`]] as const).map(([v, label]) => (
            <button key={v} type="button" role="tab" aria-selected={(v === "unread") === unreadOnly} onClick={() => set({ show: v === "unread" ? "unread" : null, page: null })}
              className={cn("rounded-md px-2.5 py-1 text-sm", (v === "unread") === unreadOnly ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>{label}</button>
          ))}
        </div>
        <FetchingIndicator show={q.isFetching && !q.isInitialLoading} />
        <span className="flex-1" />
        {data?.unread ? <Button variant="ghost" size="sm" onClick={() => void readAll()}><CheckCheck /> Mark all read</Button> : null}
      </div>
      {q.error && !data ? <ErrorState message={q.error} onRetry={q.refetch} /> : q.isInitialLoading || !data ? <ListSkeleton /> : !data.total ? (
        <EmptyState title={unreadOnly ? "All caught up" : "No notifications yet"} description={unreadOnly ? undefined : "Alerts about your leads, tasks and projects show up here."} />
      ) : (
        <div className={cn("space-y-4", q.isStale && "opacity-60")}>
          {groups.map((g) => (
            <section key={g.day} className="space-y-1.5">
              <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{g.day}</h2>
              <Card className="gap-0 py-0"><ul className="divide-y">{g.items.map((n) => <NotificationRow key={n.id} n={n} full onOpen={() => void open(n)} />)}</ul></Card>
            </section>
          ))}
          <DataPagination page={page} pageSize={pageSize} total={data.total} disabled={q.isFetching}
            onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s), page: null })} />
        </div>
      )}
    </>
  );
}
