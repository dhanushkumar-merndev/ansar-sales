"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { NotificationIcon } from "@/components/app/notification-icon";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useLiveQuery } from "@/hooks/use-live-query";
import { notificationTarget, showNotification, type AppNotification } from "@/lib/app-notifications";
import { fetchMyNotifications } from "@/lib/queries";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { markNotificationsRead } from "@/server/actions/telegram";

const TABLES = ["app_notifications"];

/**
 * Opens a notification's page and marks it read. One from another company switches to that company
 * first, with a full load like the company switcher, so the sidebar and every list belong to it.
 */
export function useOpenNotification() {
  const me = useProfile();
  const router = useRouter();
  return async (n: AppNotification) => {
    const { href } = showNotification(n);
    const { path, switchTo } = notificationTarget(href, me.company.id);
    if (!switchTo) router.push(path);
    if (!n.read_at) await markNotificationsRead({ ids: [n.id] });
    if (switchTo) window.location.assign(href);
  };
}

/** The bell: unread count, the latest 20, and a toast when something new arrives while the app is open. */
export function NotificationBell() {
  const me = useProfile();
  const openNotification = useOpenNotification();
  const [open, setOpen] = useState(false);
  const q = useLiveQuery({ queryKey: `bell:${me.id}`, fetcher: (s) => fetchMyNotifications({ unread: false, page: 1, pageSize: 20 }, s), tables: TABLES });
  const unread = q.data?.unread ?? 0;

  const go = async (n: AppNotification) => {
    setOpen(false);
    await openNotification(n);
    if (!n.read_at) q.refetch();
  };
  // Toast only what arrives after the first load (not the backlog), once each.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const items = q.data?.items;
    if (!items) return;
    if (!seen.current) { seen.current = new Set(items.map((n) => n.id)); return; }
    for (const n of items) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      if (n.read_at || Date.now() - Date.parse(n.created_at) > 5 * 60_000) continue;
      const s = showNotification(n);
      toast(s.title, { icon: <NotificationIcon emoji={s.icon} className="size-4 bg-transparent" />, description: s.details[0], action: { label: "View", onClick: () => void go(n) } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per new data; go() only reads stable values
  }, [q.data]);

  const readAll = async () => {
    const r = await markNotificationsRead({});
    if (!r.ok) return void toast.error(r.error);
    q.refetch();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
          <Bell />
          {unread ? (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white tabular-nums">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <span className="flex-1 text-sm font-medium">Notifications{unread ? <span className="ml-1 text-muted-foreground">· {unread} unread</span> : null}</span>
          {unread ? <Button size="xs" variant="ghost" onClick={() => void readAll()}><CheckCheck /> Mark all read</Button> : null}
        </div>
        <div className="max-h-[min(70dvh,32rem)] overflow-y-auto">
          {q.error && !q.data ? <p className="p-4 text-sm text-red-300">Couldn&apos;t load notifications.</p>
            : !q.data ? <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            : !q.data.items.length ? <p className="p-6 text-center text-sm text-muted-foreground">Nothing yet. Alerts about your work show up here.</p>
            : <ul className="divide-y">{q.data.items.map((n) => <NotificationRow key={n.id} n={n} onOpen={() => void go(n)} />)}</ul>}
        </div>
        <div className="border-t p-1.5">
          <Button asChild variant="ghost" size="sm" className="w-full" onClick={() => setOpen(false)}><Link href="/notifications">See all</Link></Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One item: icon, title, its first detail, when, and an unread dot. */
export function NotificationRow({ n, onOpen, full = false }: { n: AppNotification; onOpen: () => void; full?: boolean }) {
  const s = showNotification(n);
  return (
    <li>
      <button type="button" onClick={onOpen} className={cn("flex w-full gap-3 px-3 py-2.5 text-left hover:bg-accent/40", !n.read_at && "bg-sky-400/[0.05]")}>
        <NotificationIcon emoji={s.icon} />
        <span className="min-w-0 flex-1">
          <span className={cn("block text-sm", !n.read_at && "font-medium")}>{s.title}</span>
          {s.company ? <span className="block text-xs text-amber-200/80">{s.company}</span> : null}
          {(full ? s.details : s.details.slice(0, 2)).map((d, i) => <span key={i} className="block truncate text-xs text-muted-foreground">{d}</span>)}
          <span className="mt-0.5 block text-[11px] text-muted-foreground/80">{formatRelative(n.created_at)}</span>
        </span>
        {!n.read_at ? <span className="mt-1.5 size-2 shrink-0 rounded-full bg-sky-400" aria-label="Unread" /> : null}
      </button>
    </li>
  );
}
