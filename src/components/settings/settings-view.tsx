"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, ExternalLink, Loader2, Send, Unplug } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { PageHeader } from "@/components/common/page-header";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveQuery } from "@/hooks/use-live-query";
import { ROLE_LABELS } from "@/lib/constants";
import { fetchTelegramStatus } from "@/lib/queries";
import { formatDateTime } from "@/lib/time";
import { changePassword } from "@/server/actions/auth";
import { createTelegramLink, disconnectTelegram } from "@/server/actions/telegram";

export function SettingsView() {
  const profile = useProfile();
  return (
    <>
      <PageHeader title="Settings" description="Your account and notifications." />
      <div className="grid max-w-3xl gap-5">
        <Card>
          <CardHeader><CardTitle className="text-base">Profile</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <span className="text-muted-foreground">Name</span><span>{profile.display_name}</span>
            <span className="text-muted-foreground">Username</span><span>@{profile.username}</span>
            <span className="text-muted-foreground">Role</span><span>{ROLE_LABELS[profile.role]}</span>
          </CardContent>
        </Card>
        <TelegramCard />
        <PasswordCard />
      </div>
    </>
  );
}

function TelegramCard() {
  const [pending, start] = useTransition();
  const [link, setLink] = useState<string | null>(null);
  // Telegram connection is not published over Realtime; poll briefly while a link is outstanding.
  const status = useLiveQuery({ queryKey: "telegram-status", fetcher: fetchTelegramStatus, pollMs: link ? 4000 : 60_000 });
  const conn = status.data;
  const connected = conn?.status === "connected";

  return (
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
                  setLink(r.data.url);
                  window.open(r.data.url, "_blank", "noopener,noreferrer");
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
            {link && !connected ? (
              <p className="rounded-md border bg-muted/40 p-3 text-muted-foreground">
                In Telegram, press <strong>Start</strong> in the bot chat. The link is valid for 15 minutes and works once.{" "}
                <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-foreground underline">Open again <ExternalLink className="size-3" /></a>
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError("New passwords don't match.");
    start(async () => {
      const r = await changePassword({ currentPassword: current, newPassword: next });
      if (!r.ok) return setError(r.error);
      setError(null);
      setCurrent(""); setNext(""); setConfirm("");
      toast.success("Password changed");
    });
  };
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Change password</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={submit} className="max-w-sm" noValidate>
          <FieldGroup className="gap-3">
            <Field><FieldLabel htmlFor="pw-current">Current password</FieldLabel><Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
            <Field><FieldLabel htmlFor="pw-new">New password</FieldLabel><Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
            <Field><FieldLabel htmlFor="pw-confirm">Confirm new password</FieldLabel><Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button type="submit" disabled={pending || !current || next.length < 8} className="w-fit">{pending && <Loader2 className="animate-spin" />}Update password</Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
