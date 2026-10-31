"use client";

import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveQuery } from "@/hooks/use-live-query";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/time";
import { whatsappSetupInfo } from "@/server/actions/whatsapp";

type WaStatus = {
  linked: number; active: number; open_windows: number; blocked: number; held: number;
  sent_24h: number; failed_24h: number; last_failure: string | null;
  seen: Partial<Record<"message" | "link" | "status_failed" | "unknown_sender", string>>;
};

async function fetchStatus(signal: AbortSignal) {
  const { data, error } = await createClient().rpc("super_whatsapp_status").abortSignal(signal);
  if (error) {
    if (error.code === "PGRST202") return null; // migration 20261008005800 not applied yet
    throw error;
  }
  return data as unknown as WaStatus;
}

const FAILURE_TEXT: Record<string, string> = {
  whatsapp_token_invalid: "The access token is invalid or expired. Make a new system-user token and update WHATSAPP_ACCESS_TOKEN.",
  whatsapp_not_configured: "The worker has no WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID secrets.",
  whatsapp_test_number_not_allowed: "The Meta app is in development mode: add the number as a test recipient, or switch the app to Live.",
  whatsapp_undeliverable: "A number couldn't receive WhatsApp messages.",
};

/** WhatsApp alerts at a glance for the super admin: counts only, never anyone's number or a secret. */
export function WhatsAppTab() {
  const status = useLiveQuery({ queryKey: "super-whatsapp-status", fetcher: fetchStatus });
  const [info, setInfo] = useState<{ number: string | null; webhookUrl: string | null } | null>(null);
  useEffect(() => {
    void whatsappSetupInfo().then((r) => { if (r.ok) setInfo(r.data); });
  }, []);
  const s = status.data;
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success("Copied"), () => toast.error("Couldn't copy"));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Setup</CardTitle>
          <CardDescription>
            One business number for the whole CRM, on a Meta app used only for WhatsApp. Keys live in Supabase Edge Function secrets, never in the database.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row label="Business number (WHATSAPP_BUSINESS_NUMBER in Vercel)">
            {info === null ? <Skeleton className="h-5 w-32" /> : info.number ?? <span className="text-amber-300">Not set: Connect WhatsApp is hidden</span>}
          </Row>
          <Row label="Webhook URL (paste into Meta → WhatsApp → Configuration)">
            {info?.webhookUrl ? (
              <span className="flex items-center gap-1.5">
                <code className="break-all text-xs">{info.webhookUrl}</code>
                <Button variant="ghost" size="icon-sm" onClick={() => copy(info.webhookUrl!)} aria-label="Copy the webhook URL"><Copy /></Button>
              </span>
            ) : <Skeleton className="h-5 w-48" />}
          </Row>
          <Row label="Last message received">{s?.seen.message ? formatDateTime(s.seen.message) : "Never"}</Row>
          <Row label="Last number linked">{s?.seen.link ? formatDateTime(s.seen.link) : "Never"}</Row>
          {s?.seen.unknown_sender ? <Row label="Last message from an unlinked number">{formatDateTime(s.seen.unknown_sender)}</Row> : null}
          <p className="text-xs text-muted-foreground">
            Messages are free while a person&apos;s 24-hour window is open (the CRM reminds them daily to keep it open). Nothing paid is sent unless
            WHATSAPP_REOPEN_TEMPLATE is set on the worker.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery</CardTitle>
          <CardDescription>Everyone together. Each person links and tests from their own Settings.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {status.error && !s ? <ErrorState message={status.error} onRetry={status.refetch} />
            : status.isInitialLoading ? <Skeleton className="h-40 w-full" />
            : !s ? <p className="text-muted-foreground">The database doesn&apos;t have WhatsApp yet (migration 20261008005800).</p>
            : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Stat label="Linked" value={s.linked} />
                  <Stat label="Using WhatsApp" value={s.active} />
                  <Stat label="Window open" value={s.open_windows} />
                  <Stat label="Alerts waiting" value={s.held} tone={s.held ? "amber" : undefined} />
                  <Stat label="Sent (24 h)" value={s.sent_24h} />
                  <Stat label="Failed (24 h)" value={s.failed_24h} tone={s.failed_24h ? "red" : undefined} />
                </div>
                {s.blocked ? <p className="text-amber-300">{s.blocked} linked number{s.blocked === 1 ? "" : "s"} can&apos;t be reached.</p> : null}
                {s.last_failure ? <p className="text-red-300">Last failure: {FAILURE_TEXT[s.last_failure] ?? s.last_failure}</p> : null}
              </div>
            )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-foreground">{children}</div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "amber" | "red" }) {
  return (
    <div className="rounded-xl border border-white/[0.08] px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={tone === "red" ? "text-lg font-semibold text-red-300" : tone === "amber" ? "text-lg font-semibold text-amber-300" : "text-lg font-semibold"}>{value}</div>
    </div>
  );
}
