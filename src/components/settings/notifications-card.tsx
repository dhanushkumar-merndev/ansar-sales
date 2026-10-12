"use client";

import { useState } from "react";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import { useProfile } from "@/components/providers/profile-provider";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveQuery } from "@/hooks/use-live-query";
import { notificationKindsFor, type NotificationKind } from "@/lib/notifications";
import { fetchNotificationSettings } from "@/lib/queries";
import { setNotificationPref } from "@/server/actions/telegram";

type Channel = "app" | "telegram";

/** Per-type switches for the signed-in user's roles: in the app (the bell) and on Telegram, separately. */
export function NotificationsCard({ connected }: { connected: boolean }) {
  const profile = useProfile();
  const kinds = notificationKindsFor(profile.roles, profile.features);
  const settings = useLiveQuery({ queryKey: `notification-settings:${profile.id}`, fetcher: fetchNotificationSettings });
  // Optimistic overrides until the saved lists come back.
  const [overrides, setOverrides] = useState<Record<string, boolean | undefined>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const key = (kind: NotificationKind, channel: Channel) => `${channel}:${kind}`;
  const enabled = (kind: NotificationKind, channel: Channel) => overrides[key(kind, channel)] ?? !(settings.data?.[channel] ?? []).includes(kind);

  const toggle = async (kind: NotificationKind, channel: Channel, on: boolean) => {
    const k = key(kind, channel);
    setOverrides((o) => ({ ...o, [k]: on }));
    setSaving(k);
    const r = await setNotificationPref({ kind, enabled: on, channel });
    setSaving(null);
    if (!r.ok) toast.error(r.error);
    await settings.refetch();
    setOverrides((o) => ({ ...o, [k]: undefined }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><BellRing className="size-4" /> Notifications</CardTitle>
        <CardDescription>
          Choose what reaches you in the CRM (the bell at the top) and on Telegram.
          {connected ? " Each Telegram message has a button to open it in the CRM." : " Connect Telegram above to also get them there."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {settings.isInitialLoading ? <Skeleton className="h-40 w-full" /> : (
          <div className="rounded-lg border">
            <div className="flex items-center gap-3 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
              <span className="flex-1">Notification</span>
              <span className="w-16 text-center">In app</span>
              <span className="w-16 text-center">Telegram</span>
            </div>
            <ul className="divide-y">
              {kinds.map((k) => (
                <li key={k.kind} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground">{k.label}</div>
                    <div className="text-xs text-muted-foreground">{k.description}</div>
                  </div>
                  <span className="flex w-16 justify-center">
                    <Checkbox checked={enabled(k.kind, "app")} disabled={saving === key(k.kind, "app")} aria-label={`${k.label} in the app`}
                      onCheckedChange={(c) => void toggle(k.kind, "app", c === true)} />
                  </span>
                  <span className="flex w-16 justify-center" title={connected ? undefined : "Connect Telegram first"}>
                    <Checkbox checked={connected && enabled(k.kind, "telegram")} disabled={!connected || saving === key(k.kind, "telegram")}
                      aria-label={`${k.label} on Telegram`} onCheckedChange={(c) => void toggle(k.kind, "telegram", c === true)} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
