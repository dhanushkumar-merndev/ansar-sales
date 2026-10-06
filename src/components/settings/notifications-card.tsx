"use client";

import { useState, useTransition } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveQuery } from "@/hooks/use-live-query";
import { notificationKindsFor, type NotificationKind } from "@/lib/notifications";
import { fetchNotificationSettings } from "@/lib/queries";
import { sendTestNotification, setNotificationPref } from "@/server/actions/telegram";

/** Per-type Telegram notification switches for the signed-in user's role. */
export function NotificationsCard({ connected }: { connected: boolean }) {
  const profile = useProfile();
  const kinds = notificationKindsFor(profile.role);
  const settings = useLiveQuery({ queryKey: `notification-settings:${profile.id}`, fetcher: fetchNotificationSettings });
  // Optimistic overrides until the saved list comes back.
  const [overrides, setOverrides] = useState<Partial<Record<NotificationKind, boolean>>>({});
  const [saving, setSaving] = useState<NotificationKind | null>(null);
  const [testing, startTest] = useTransition();

  const enabled = (kind: NotificationKind) => overrides[kind] ?? !(settings.data ?? []).includes(kind);

  const toggle = async (kind: NotificationKind, on: boolean) => {
    setOverrides((o) => ({ ...o, [kind]: on }));
    setSaving(kind);
    const r = await setNotificationPref({ kind, enabled: on });
    setSaving(null);
    if (!r.ok) toast.error(r.error);
    await settings.refetch();
    setOverrides((o) => ({ ...o, [kind]: undefined }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><BellRing className="size-4" /> Telegram notifications</CardTitle>
        <CardDescription>
          {connected ? "Choose what the CRM sends to your Telegram. Each message has a button to open it in the CRM." : "Connect Telegram above to receive these notifications."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {settings.isInitialLoading ? <Skeleton className="h-40 w-full" /> : (
          <ul className="divide-y rounded-lg border">
            {kinds.map((k) => (
              <li key={k.kind} className="flex items-start gap-3 px-3 py-2.5">
                <Checkbox
                  id={`notify-${k.kind}`}
                  className="mt-0.5"
                  checked={enabled(k.kind)}
                  disabled={!connected || saving === k.kind}
                  onCheckedChange={(c) => void toggle(k.kind, c === true)}
                />
                <Label htmlFor={`notify-${k.kind}`} className="flex flex-col items-start gap-0.5 font-normal">
                  <span className="font-medium text-foreground">{k.label}</span>
                  <span className="text-xs text-muted-foreground">{k.description}</span>
                </Label>
              </li>
            ))}
          </ul>
        )}
        <Button
          variant="outline"
          disabled={!connected || testing}
          onClick={() => startTest(async () => {
            const r = await sendTestNotification();
            if (!r.ok) return void toast.error(r.error);
            toast.success("Test message queued. It should arrive within about a minute.");
          })}
        >
          {testing ? <Loader2 className="animate-spin" /> : <BellRing />} Send test message
        </Button>
      </CardContent>
    </Card>
  );
}
