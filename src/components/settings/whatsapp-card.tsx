"use client";

import { useEffect, useState, useTransition } from "react";
import { BellRing, CheckCircle2, ExternalLink, Loader2, MessageCircle, QrCode, Unplug } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsMobile } from "@/hooks/use-mobile";
import type { NotifyChannels } from "@/lib/queries";
import { formatDateTime, formatTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { sendTestNotification } from "@/server/actions/telegram";
import { createWhatsAppLink, disconnectWhatsApp, setNotifyChannel } from "@/server/actions/whatsapp";

type Status = { data: NotifyChannels | undefined; isInitialLoading: boolean; refetch: () => unknown };

/**
 * WhatsApp alerts. Connecting opens WhatsApp with a one-time code typed in; sending it from the person's own
 * WhatsApp links that number (the CRM never asks for a number). Free because every alert goes out within
 * 24 hours of the person's last message; a daily "Keep alerts on" tap keeps that window open.
 */
export function WhatsAppCard({ status, businessNumber, onLinking }: { status: Status; businessNumber: string; onLinking: (pending: boolean) => void }) {
  const [pending, start] = useTransition();
  const [testing, startTest] = useTransition();
  const isMobile = useIsMobile();
  const [link, setLink] = useState<{ url: string; code: string; previousConnectedAt: string | null } | null>(null);
  const wa = status.data?.whatsapp ?? null;
  const active = status.data?.active === "whatsapp";
  const connected = wa?.status === "connected";
  const linkUsed = !!link && connected && wa?.connected_at !== link.previousConnectedAt;
  const pendingLink = link && !linkUsed ? link : null;
  useEffect(() => onLinking(!!pendingLink), [pendingLink, onLinking]);
  const chatUrl = `https://wa.me/${businessNumber}`;

  if (status.data?.unavailable) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          WhatsApp alerts
          {status.isInitialLoading ? null : !wa ? <Badge variant="outline">Not connected</Badge>
            : wa.status === "blocked" ? <Badge variant="outline" className="border-red-400/30 bg-red-400/10 text-red-300">Can&apos;t reach</Badge>
            : wa.window_until ? <Badge variant="outline" className="gap-1 border-emerald-400/30 bg-emerald-400/10 text-emerald-300"><CheckCircle2 className="size-3" />Connected</Badge>
            : <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 text-amber-300">Paused</Badge>}
        </CardTitle>
        <CardDescription>
          Get your CRM alerts on WhatsApp, free. WhatsApp lets the CRM message you for 24 hours after your last message, so once a day
          we ask you to tap <span className="text-foreground">Keep alerts on</span>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status.isInitialLoading ? <Skeleton className="h-9 w-48" /> : (
          <>
            {wa ? (
              <div className="space-y-1 text-muted-foreground">
                <p>Linked to <span className="font-mono text-foreground">{wa.masked}</span> · since {formatDateTime(wa.connected_at)}</p>
                {wa.status === "blocked" ? (
                  <p className="text-red-300">WhatsApp couldn&apos;t deliver to this number. If you blocked the CRM&apos;s number, unblock it and send it any message.</p>
                ) : wa.window_until ? (
                  <p>{active ? "Active" : "Linked"}: free until <span className="text-foreground">{formatTime(wa.window_until)} IST</span>. We&apos;ll remind you before then.</p>
                ) : (
                  <p className="text-amber-300">
                    Paused: send any message to the CRM on WhatsApp to get alerts again
                    {wa.held ? <> ({wa.held} waiting)</> : null}.
                  </p>
                )}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending}
                onClick={() => start(async () => {
                  const r = await createWhatsAppLink();
                  if (!r.ok) return void toast.error(r.error);
                  setLink({ url: r.data.url, code: r.data.code, previousConnectedAt: wa?.connected_at ?? null });
                  // On a phone, open WhatsApp directly; on a computer, show a QR code to scan instead.
                  if (isMobile) window.open(r.data.url, "_blank", "noopener,noreferrer");
                })}
              >
                {pending ? <Loader2 className="animate-spin" /> : <MessageCircle />}
                {wa ? "Reconnect WhatsApp" : "Connect WhatsApp"}
              </Button>
              {wa && !wa.window_until ? (
                <Button variant="outline" asChild>
                  <a href={chatUrl} target="_blank" rel="noopener noreferrer"><ExternalLink /> Open the CRM chat</a>
                </Button>
              ) : null}
              {connected && active ? (
                <Button
                  variant="outline"
                  disabled={testing}
                  onClick={() => startTest(async () => {
                    const r = await sendTestNotification();
                    if (!r.ok) return void toast.error(r.error);
                    toast.success(wa?.window_until ? "Test message queued. It should arrive within about a minute." : "Test queued. It arrives once you send the CRM any message on WhatsApp.");
                  })}
                >
                  {testing ? <Loader2 className="animate-spin" /> : <BellRing />} Send test message
                </Button>
              ) : null}
              {wa ? (
                <ConfirmDialog
                  trigger={<Button variant="outline"><Unplug /> Disconnect</Button>}
                  title="Disconnect WhatsApp?"
                  description={active ? "Your alerts will go to Telegram if it's connected, otherwise only to the bell in the CRM." : "This number will no longer be linked to your account."}
                  confirmLabel="Disconnect"
                  destructive
                  onConfirm={async () => {
                    const r = await disconnectWhatsApp();
                    if (!r.ok) { toast.error(r.error); return false; }
                    toast.success("WhatsApp disconnected");
                    status.refetch();
                  }}
                />
              ) : null}
            </div>
            {pendingLink ? (
              <div className="flex flex-col items-center gap-4 rounded-md border bg-muted/40 p-4 sm:flex-row sm:items-start">
                {/* Rendered locally: the link holds a one-time code, so it is never sent to a QR service. */}
                <div className="hidden shrink-0 rounded-md bg-white p-3 md:block">
                  <QRCodeSVG value={pendingLink.url} size={168} marginSize={0} title="Scan to connect WhatsApp" />
                </div>
                <div className="space-y-2 text-muted-foreground">
                  <p className="hidden items-center gap-1.5 font-medium text-foreground md:flex"><QrCode className="size-4" /> Scan with your phone camera</p>
                  <ol className="list-decimal space-y-1 pl-4">
                    <li className="hidden md:list-item">Point your phone camera at the code and open the link in WhatsApp.</li>
                    <li>WhatsApp opens with <span className="font-mono text-foreground">Link my CRM: {pendingLink.code}</span> typed in. Press <strong>Send</strong>.</li>
                    <li>This page shows <em>Connected</em> within a few seconds.</li>
                  </ol>
                  <p className="text-xs">The code works once, for 10 minutes. Send it from the WhatsApp number that should get your alerts.</p>
                  <a href={pendingLink.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-foreground underline">
                    {isMobile ? "Open WhatsApp again" : "Or open WhatsApp on this computer"} <ExternalLink className="size-3" />
                  </a>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Which linked channel gets the alerts. Shown only when both are linked. */
export function ChannelPicker({ active, onChanged }: { active: "telegram" | "whatsapp"; onChanged: () => void }) {
  const [pending, start] = useTransition();
  const pick = (channel: "telegram" | "whatsapp") => start(async () => {
    if (channel === active) return;
    const r = await setNotifyChannel({ channel });
    if (!r.ok) return void toast.error(r.error);
    toast.success(channel === "whatsapp" ? "Alerts now go to WhatsApp" : "Alerts now go to Telegram");
    onChanged();
  });
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm">
        <div>
          <p className="font-medium">Alerts go to</p>
          <p className="text-xs text-muted-foreground">One at a time, so you never get the same alert twice.</p>
        </div>
        <div role="radiogroup" aria-label="Alerts go to" className="inline-flex rounded-xl border border-white/[0.12] p-0.5">
          {(["whatsapp", "telegram"] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={active === c}
              disabled={pending}
              onClick={() => pick(c)}
              className={cn("rounded-lg px-3 py-1.5 text-sm transition-colors disabled:opacity-60",
                active === c ? "bg-white/[0.1] font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {c === "whatsapp" ? "WhatsApp" : "Telegram"}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
