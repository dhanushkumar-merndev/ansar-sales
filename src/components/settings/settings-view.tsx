"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, ExternalLink, Loader2, QrCode, Send, Unplug } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { BrandName } from "@/components/app/brand";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { PageHeader } from "@/components/common/page-header";
import { NotificationsCard } from "@/components/settings/notifications-card";
import { UsageView } from "@/components/settings/usage-view";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useIsMobile } from "@/hooks/use-mobile";
import { useUrlState } from "@/hooks/use-url-state";
import { ROLE_LABELS } from "@/lib/constants";
import { fetchTelegramStatus } from "@/lib/queries";
import { formatDateTime } from "@/lib/time";
import { changePassword } from "@/server/actions/auth";
import { createTelegramLink, disconnectTelegram } from "@/server/actions/telegram";

export function SettingsView() {
  const profile = useProfile();
  const { params, set } = useUrlState();
  const isAdmin = profile.role === "admin";
  const tab = isAdmin && params.get("tab") === "usage" ? "usage" : "account";
  return (
    <div className="w-full space-y-6">
      <PageHeader
        title="Settings"
        description={tab === "usage"
          ? "How much of the Supabase plan the CRM uses, and what you can clean up."
          : "Your account credentials, workspace profile and Telegram reminder integration."}
      />
      {isAdmin ? (
        <Tabs value={tab} onValueChange={(v) => set({ tab: v === "usage" ? "usage" : null })}>
          <TabsList><TabsTrigger value="account">Account</TabsTrigger><TabsTrigger value="usage">Usage</TabsTrigger></TabsList>
        </Tabs>
      ) : null}
      {tab === "usage" ? <UsageView /> : <AccountSettings />}
    </div>
  );
}

function AccountSettings() {
  const profile = useProfile();
  return (
      <div className="grid w-full grid-cols-1 gap-6 lg:grid-cols-2 items-start">
        {/* Left Column: Identity & Permissions */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-11 items-center justify-center rounded-full bg-white/[0.08] text-base font-semibold text-foreground ring-1 ring-white/[0.12]">
                  {profile.display_name.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <CardTitle className="truncate text-base">{profile.display_name}</CardTitle>
                    <Badge variant="outline" className="border-white/10 bg-white/5 text-xs text-foreground">
                      {ROLE_LABELS[profile.role]}
                    </Badge>
                  </div>
                  <CardDescription className="truncate text-xs">@{profile.username}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-1 text-sm">
              <div className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.08] bg-background/50">
                <div className="flex items-center justify-between px-3.5 py-2.5">
                  <span className="text-xs text-muted-foreground">Display name</span>
                  <span className="font-medium text-foreground">{profile.display_name}</span>
                </div>
                <div className="flex items-center justify-between px-3.5 py-2.5">
                  <span className="text-xs text-muted-foreground">Username</span>
                  <span className="font-mono text-xs text-foreground">@{profile.username}</span>
                </div>
                <div className="flex items-center justify-between px-3.5 py-2.5">
                  <span className="text-xs text-muted-foreground">Access role</span>
                  <span className="font-medium text-foreground">{ROLE_LABELS[profile.role]}</span>
                </div>
                <div className="flex items-center justify-between px-3.5 py-2.5">
                  <span className="text-xs text-muted-foreground">Workspace</span>
                  <BrandName suffix="CRM" className="font-medium text-foreground" />
                </div>
                <div className="flex items-center justify-between px-3.5 py-2.5">
                  <span className="text-xs text-muted-foreground">Account status</span>
                  <span className="inline-flex items-center gap-1.5 font-medium text-emerald-400 text-xs">
                    <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.7)]" />
                    Active
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">Role privileges</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground space-y-2 pt-0">
              {profile.role === "admin" && (
                <ul className="list-disc space-y-1.5 pl-4 text-foreground/80">
                  <li>Manage team users, reset passwords & update roles</li>
                  <li>Full pipeline visibility across all sales representatives</li>
                  <li>Assign, reassign, archive & restore leads</li>
                  <li>Manage niche categories (rename & merge)</li>
                  <li>Access company capital & operating expenses</li>
                </ul>
              )}
              {profile.role === "sales" && (
                <ul className="list-disc space-y-1.5 pl-4 text-foreground/80">
                  <li>Create leads & track personal sales pipeline</li>
                  <li>Schedule, complete & reschedule follow-ups</li>
                  <li>Add and correct lead notes with audit timeline</li>
                  <li>Personal sales performance analytics</li>
                  <li>Receive private Telegram task reminders</li>
                </ul>
              )}
              {profile.role === "account" && (
                <ul className="list-disc space-y-1.5 pl-4 text-foreground/80">
                  <li>Record contributed capital entries</li>
                  <li>Track monthly operating expense categories</li>
                  <li>Audit trail for financial corrections</li>
                  <li>Finance summary dashboard & metrics</li>
                </ul>
              )}
            </CardContent>
          </Card>

          <PasswordCard />
        </div>

        {/* Right Column: Telegram */}
        <div className="space-y-6">
          <TelegramCard />
        </div>
      </div>
  );
}

function TelegramCard() {
  const [pending, start] = useTransition();
  const isMobile = useIsMobile();
  const [link, setLink] = useState<{ url: string; previousConnectedAt: string | null } | null>(null);
  // Telegram connection is not published over Realtime; poll briefly while a link is outstanding.
  const status = useLiveQuery({ queryKey: "telegram-status", fetcher: fetchTelegramStatus, pollMs: link ? 4000 : 60_000 });
  const conn = status.data;
  const connected = conn?.status === "connected";
  // The link is done once the connection changes after it was created (also covers Reconnect).
  const linkUsed = !!link && connected && conn?.connected_at !== link.previousConnectedAt;
  const pendingLink = link && !linkUsed ? link.url : null;

  return (
    <>
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Telegram reminders
          {status.isInitialLoading ? null : connected ? (
            <Badge variant="outline" className="gap-1 border-emerald-200 bg-emerald-50 text-emerald-800"><CheckCircle2 className="size-3" />Connected</Badge>
          ) : conn?.status === "blocked" ? (
            <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">Bot blocked</Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
        </CardTitle>
        <CardDescription>Get a private Telegram message when a follow-up assigned to you is due (usually within about a minute).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status.isInitialLoading ? <Skeleton className="h-9 w-48" /> : (
          <>
            {conn ? (
              <p className="text-muted-foreground">
                {conn.telegram_username ? <>Linked to <span className="text-foreground">@{conn.telegram_username}</span> · </> : null}
                since {formatDateTime(conn.connected_at)}
                {conn.status === "blocked" ? <span className="block text-red-700">Reminders are failing because the bot was blocked or the chat is unavailable. Reconnect below.</span> : null}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending}
                onClick={() => start(async () => {
                  const r = await createTelegramLink();
                  if (!r.ok) return void toast.error(r.error);
                  setLink({ url: r.data.url, previousConnectedAt: conn?.connected_at ?? null });
                  // On a phone, open Telegram directly; on a computer, show a QR code to scan instead.
                  if (isMobile) window.open(r.data.url, "_blank", "noopener,noreferrer");
                })}
              >
                {pending ? <Loader2 className="animate-spin" /> : <Send />}
                {connected ? "Reconnect Telegram" : "Connect Telegram"}
              </Button>
              {conn ? (
                <ConfirmDialog
                  trigger={<Button variant="outline"><Unplug /> Disconnect</Button>}
                  title="Disconnect Telegram?"
                  description="You will stop receiving follow-up reminders."
                  confirmLabel="Disconnect"
                  destructive
                  onConfirm={async () => {
                    const r = await disconnectTelegram();
                    if (!r.ok) { toast.error(r.error); return false; }
                    toast.success("Telegram disconnected");
                    status.refetch();
                  }}
                />
              ) : null}
            </div>
            {pendingLink ? (
              <div className="flex flex-col items-center gap-4 rounded-md border bg-muted/40 p-4 sm:flex-row sm:items-start">
                {/* Rendered locally: the link holds a single-use token, so it is never sent to a QR service. */}
                <div className="hidden shrink-0 rounded-md bg-white p-3 md:block">
                  <QRCodeSVG value={pendingLink} size={168} marginSize={0} title="Scan to connect Telegram" />
                </div>
                <div className="space-y-2 text-muted-foreground">
                  <p className="hidden items-center gap-1.5 font-medium text-foreground md:flex"><QrCode className="size-4" /> Scan with your phone camera</p>
                  <ol className="list-decimal space-y-1 pl-4">
                    <li className="hidden md:list-item">Point your phone camera at the code and open the link in Telegram.</li>
                    <li>Press <strong>Start</strong> in the bot chat.</li>
                    <li>This page shows <em>Connected</em> within a few seconds.</li>
                  </ol>
                  <p className="text-xs">The link is valid for 15 minutes and works once.</p>
                  <a href={pendingLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-foreground underline">
                    {isMobile ? "Open Telegram again" : "Or open Telegram on this computer"} <ExternalLink className="size-3" />
                  </a>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
    <NotificationsCard connected={connected} />
    </>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, start] = useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return void toast.error("New passwords don't match.");
    start(async () => {
      const r = await changePassword({ currentPassword: current, newPassword: next });
      if (!r.ok) return void toast.error(r.error);
      setCurrent(""); setNext(""); setConfirm("");
      toast.success("Password changed");
    });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Change password</CardTitle>
        <CardDescription>Keep your account secure with a strong password (minimum 8 characters).</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="w-full" noValidate>
          <FieldGroup className="gap-3.5">
            <Field>
              <FieldLabel htmlFor="pw-current">Current password</FieldLabel>
              <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="pw-new">New password</FieldLabel>
              <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="pw-confirm">Confirm new password</FieldLabel>
              <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <div className="pt-1">
              <Button type="submit" disabled={pending || !current || next.length < 8} className="w-fit">
                {pending && <Loader2 className="animate-spin" />}Update password
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
