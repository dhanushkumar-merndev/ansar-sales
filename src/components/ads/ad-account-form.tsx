"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, ExternalLink, Loader2, PlugZap, Save, Unplug, XCircle } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AdAccount } from "@/lib/ads";
import { formatDateTime, formatRelative } from "@/lib/time";
import { disconnectAdAccount, saveAdAccount, testAdAccount } from "@/server/actions/ads";
import type { ConnectStep } from "@/server/ads-sync";

export function AdAccountStatus({ account }: { account: AdAccount | null }) {
  if (!account || account.archived_at) return <Badge variant="outline" className="text-muted-foreground">Not connected</Badge>;
  if (account.sync_paused) return <Badge variant="outline" className="text-muted-foreground">Sync paused</Badge>;
  const map = {
    unverified: ["Saved, not tested", "border-amber-400/30 text-amber-300"],
    connected: ["Connected", "border-emerald-400/30 text-emerald-300"],
    error: ["Problem", "border-red-400/30 text-red-300"],
  } as const;
  return <Badge variant="outline" className={map[account.status][1]}>{map[account.status][0]}</Badge>;
}

/**
 * Connects a Meta ad account with its own Meta app: ad account ID, App ID, App secret and a
 * system-user token. Secrets are write-only (stored in Supabase Vault). "Connect & test" checks
 * access and starts the first sync; after that it syncs every hour.
 */
export function AdAccountForm({ kind, ownerId, account, onChanged, leadAppAvailable }: {
  kind: "company" | "client"; ownerId: string; account: AdAccount | null; onChanged: () => void;
  /** Company accounts can reuse the Facebook Lead Ads app and token when it has ads_read. */
  leadAppAvailable?: boolean;
}) {
  const live = account && !account.archived_at ? account : null;
  const [actId, setActId] = useState(live?.act_id ?? account?.act_id ?? "");
  const [appId, setAppId] = useState(live?.app_id ?? "");
  const [appSecret, setAppSecret] = useState("");
  const [token, setToken] = useState("");
  const [useLeadApp, setUseLeadApp] = useState(false);
  const [steps, setSteps] = useState<ConnectStep[] | null>(null);
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();

  const save = () => startSave(async () => {
    const r = await saveAdAccount({
      kind, ownerId, actId, appId: useLeadApp ? undefined : appId, appSecret, accessToken: token, useLeadApp,
    });
    if (!r.ok) { toast.error(r.error); return; }
    setAppSecret(""); setToken("");
    toast.success("Saved. Now press Connect & test.");
    onChanged();
  });
  const test = () => startTest(async () => {
    if (!live) return;
    setSteps(null);
    const r = await testAdAccount({ accountId: live.id });
    if (!r.ok) { toast.error(r.error); return; }
    setSteps(r.data.steps);
    if (r.data.connected) toast.success("Connected. The first sync is running; numbers appear in a minute or two.");
    onChanged();
  });

  return (
    <div className="space-y-4">
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={`act-${ownerId}`}>Ad account ID</FieldLabel>
          <Input id={`act-${ownerId}`} value={actId} onChange={(e) => setActId(e.target.value)} placeholder="act_1234567890 or 1234567890" />
          <FieldDescription>In Meta Ads Manager, the number in the account picker (also in the URL as act=…).</FieldDescription>
        </Field>
        {leadAppAvailable ? (
          <Label className="flex items-start gap-2 font-normal">
            <Checkbox checked={useLeadApp} onCheckedChange={(v) => setUseLeadApp(v === true)} className="mt-0.5" />
            <span>Use the same Meta app and token as Facebook Lead Ads <span className="block text-xs text-muted-foreground">The token must also have ads_read and the ad account assigned.</span></span>
          </Label>
        ) : null}
        {!useLeadApp ? (
          <>
            <Field>
              <FieldLabel htmlFor={`app-${ownerId}`}>App ID</FieldLabel>
              <Input id={`app-${ownerId}`} inputMode="numeric" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="e.g. 1234567890123456" />
            </Field>
            <Field>
              <FieldLabel htmlFor={`secret-${ownerId}`}>App secret</FieldLabel>
              <Input id={`secret-${ownerId}`} type="password" autoComplete="off" value={appSecret} onChange={(e) => setAppSecret(e.target.value)}
                placeholder={live ? "•••••••• saved (type to replace)" : "From App settings → Basic"} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`token-${ownerId}`}>System user access token</FieldLabel>
              <Input id={`token-${ownerId}`} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)}
                placeholder={live ? "•••••••• saved (type to replace)" : "Token that never expires, with ads_read"} />
              <FieldDescription>Stored encrypted in Supabase Vault and never shown again, not even to admins.</FieldDescription>
            </Field>
          </>
        ) : null}
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={saving || !actId || (!useLeadApp && !appId)}>{saving ? <Loader2 className="animate-spin" /> : <Save />} Save</Button>
        <Button variant="outline" onClick={test} disabled={testing || !live}>{testing ? <Loader2 className="animate-spin" /> : <PlugZap />} Connect &amp; test</Button>
        {live ? (
          <ConfirmDialog
            trigger={<Button variant="ghost"><Unplug /> Disconnect</Button>}
            title="Disconnect this ad account?"
            description="Syncing stops and the saved secrets are deleted. Everything already synced stays visible as history."
            confirmLabel="Disconnect" destructive
            onConfirm={async () => {
              const r = await disconnectAdAccount({ accountId: live.id });
              if (!r.ok) { toast.error(r.error); return false; }
              onChanged();
            }}
          />
        ) : null}
        <Button variant="link" size="sm" asChild className="px-0">
          <Link href="/help/meta-lead-ads#ads" target="_blank">Setup guide <ExternalLink /></Link>
        </Button>
      </div>
      {steps ? (
        <ol className="space-y-1.5 rounded-lg border p-3 text-sm">
          {steps.map((s) => (
            <li key={s.label} className="flex gap-2">
              {s.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-400" />}
              <span><span className="font-medium">{s.label}</span>{s.detail ? <span className="block break-all text-xs text-muted-foreground">{s.detail}</span> : null}</span>
            </li>
          ))}
        </ol>
      ) : live?.status === "error" && live.last_error ? <p className="text-sm text-red-300">{live.last_error}</p> : null}
      {live ? (
        <p className="text-xs text-muted-foreground">
          {live.name ? `${live.name} · ` : ""}{live.currency ?? ""}{live.timezone ? ` · ${live.timezone}` : ""}
          {live.last_synced_at ? ` · last synced ${formatRelative(live.last_synced_at)}` : ""}
          {live.backfilled_from ? ` · history from ${live.backfilled_from}` : ""}
          {live.last_checked_at && !live.last_synced_at ? ` · checked ${formatDateTime(live.last_checked_at)}` : ""}
        </p>
      ) : null}
    </div>
  );
}
