"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, Copy, ExternalLink, Loader2, PlugZap, RefreshCw, Save, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { type CompanyAds, CompanyCategoriesCard } from "@/components/super/company-categories-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveQuery } from "@/hooks/use-live-query";
import { publicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { AdAccount } from "@/lib/ads";
import {
  removeFacebookConnection, saveFacebookConnection, setMetaRouting, syncMetaLeads, testFacebookConnection, type ConnectStep,
} from "@/server/actions/meta";

export type MetaOverview = {
  company_id: string; company_name: string;
  integration: {
    app_id: string; page_id: string; page_name: string | null; verify_token: string; status: "unverified" | "connected" | "error";
    last_checked_at: string | null; last_event_at: string | null; last_error: string | null;
  } | null;
  routing: string[];
  /** `ours`: someone on our team, offered inside a client's CRM alongside the client's own staff. */
  candidates: { id: string; display_name: string; role: string; ours?: boolean }[];
  leads_7d: number; failed_7d: number;
  /**
   * For a client's CRM: our own Facebook connection, and the categories on our ad account that are
   * run for this client (leads from those campaigns reach the client's CRM by themselves).
   */
  agency?: { app_id: string; page_id: string; page_name: string | null; status: "unverified" | "connected" | "error"; categories: string[] } | null;
};
/** `crm`: the other CRM the lead went to (a client's), when it isn't this company's own. */
type MetaEvent = { id: string; form_name: string | null; ad_name: string | null; state: string; error: string | null; lead_id: string | null; lead_name: string | null; owner: string | null; crm?: string | null; created_at: string };

export async function fetchMetaOverview(signal: AbortSignal) {
  const { data, error } = await createClient().rpc("super_meta_overview").abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as MetaOverview[];
}

const webhookUrl = (companyId: string) => `${publicEnv.appUrl.replace(/\/+$/, "")}/api/meta/webhook/${companyId}`;

/** Super settings tab: every company's Facebook connection (lead forms and ad account) and who gets its leads. */
export function MetaLeadsTab() {
  const overview = useLiveQuery({ queryKey: "meta-overview", fetcher: fetchMetaOverview, tables: ["profiles", "companies"], pollMs: 0 });
  const adAccounts = useLiveQuery({
    queryKey: "super-ads-overview",
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("super_ads_overview").abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as unknown as CompanyAds[];
    },
    pollMs: 0,
  });
  const [companyId, setCompanyId] = useState<string | null>(null);
  if (overview.error && !overview.data) return <ErrorState message={overview.error} onRetry={overview.refetch} />;
  if (!overview.data) return <ListSkeleton rows={5} />;
  const current = overview.data.find((c) => c.company_id === companyId) ?? overview.data[0];
  if (!current) return <EmptyState title="No companies" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={current.company_id} onValueChange={setCompanyId}>
          <SelectTrigger className="w-64" aria-label="Company"><SelectValue /></SelectTrigger>
          <SelectContent>
            {overview.data.map((c) => (
              <SelectItem key={c.company_id} value={c.company_id}>{c.company_name}{c.integration ? ` · ${c.integration.status}` : ""}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="link" size="sm" asChild className="px-0">
          <Link href="/help/meta-lead-ads" target="_blank">Setup guide: create the Meta app and token <ExternalLink /></Link>
        </Button>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ConnectionCard key={`c-${current.company_id}`} company={current}
          adAccount={adAccounts.data?.find((a) => a.company_id === current.company_id)?.account ?? null}
          onChanged={() => { overview.refetch(); adAccounts.refetch(); }} />
        <div className="space-y-6">
          <RoutingCard key={`r-${current.company_id}:${current.routing.join(",")}`} company={current} onChanged={overview.refetch} />
          {adAccounts.data ? (
            <CompanyCategoriesCard key={`k-${current.company_id}`} companyId={current.company_id} companies={adAccounts.data} onChanged={adAccounts.refetch} />
          ) : null}
          <InboxCard companyId={current.company_id} />
        </div>
      </div>
    </div>
  );
}

export function MetaStatusBadge({ status }: { status: NonNullable<MetaOverview["integration"]>["status"] | "none" }) {
  const map = {
    none: ["Not connected", "text-muted-foreground"],
    unverified: ["Saved, not tested", "border-amber-400/30 text-amber-300"],
    connected: ["Connected", "border-emerald-400/30 text-emerald-300"],
    error: ["Problem", "border-red-400/30 text-red-300"],
  } as const;
  return <Badge variant="outline" className={map[status][1]}>{map[status][0]}</Badge>;
}

/**
 * One Facebook connection per company: the Meta app and token, plus the Page ID (lead forms)
 * and/or the ad account ID (Ads dashboard). Secrets are write-only.
 * `leadsOnly`: a client's CRM, where only lead forms are connected (its ads are on the client's Ad accounts tab).
 * `sharedApp`: our own Meta app can connect the client's Page, so only the Page ID is typed.
 */
export function ConnectionCard({ company, adAccount, onChanged, embedded, leadsOnly, sharedApp }: {
  company: MetaOverview; adAccount: AdAccount | null; onChanged: () => void; embedded?: boolean; leadsOnly?: boolean;
  sharedApp?: { appId: string; save: (pageId: string) => Promise<{ ok: true } | { ok: false; error: string }> };
}) {
  const i = company.integration;
  const ads = adAccount && !adAccount.archived_at ? adAccount : null;
  const saved = Boolean(i || ads);
  const [appId, setAppId] = useState(i?.app_id ?? ads?.app_id ?? "");
  const [pageId, setPageId] = useState(i?.page_id ?? "");
  const [actId, setActId] = useState(ads?.act_id ?? "");
  const [appSecret, setAppSecret] = useState("");
  const [token, setToken] = useState("");
  const [steps, setSteps] = useState<{ leads: ConnectStep[] | null; ads: ConnectStep[] | null } | null>(null);
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();
  const [syncing, startSync] = useTransition();
  // Connect & test checks the saved connection, so it's offered only when nothing is waiting to be saved.
  const [edited, setEdited] = useState(false);
  const dirty = !saved || edited;
  const edit = (set: (v: string) => void) => (v: string) => { set(v); setEdited(true); };
  // Our app unless this Page was connected with another one.
  const [ownApp, setOwnApp] = useState(Boolean(i && sharedApp && i.app_id !== sharedApp.appId));
  const shared = sharedApp && !ownApp ? sharedApp : null;

  const save = () => startSave(async () => {
    const r = shared ? await shared.save(pageId)
      : await saveFacebookConnection({ companyId: company.company_id, appId, pageId, actId, appSecret, accessToken: token });
    if (!r.ok) { toast.error(r.error); return; }
    setAppSecret(""); setToken(""); setSteps(null); setEdited(false);
    toast.success("Saved. Now press Connect & test.");
    onChanged();
  });
  const test = () => startTest(async () => {
    setSteps(null);
    const r = await testFacebookConnection({ companyId: company.company_id });
    if (!r.ok) { toast.error(r.error); return; }
    setSteps({ leads: r.data.leads?.steps ?? null, ads: r.data.ads?.steps ?? null });
    const ok = [r.data.leads, r.data.ads].filter(Boolean).every((x) => x!.connected);
    if (ok) toast.success(r.data.ads ? "Connected. Ad numbers appear in a minute or two." : "Facebook leads are connected");
    onChanged();
  });
  const sync = () => startSync(async () => {
    const r = await syncMetaLeads({ companyId: company.company_id });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(`Checked ${r.data.found} recent leads: ${r.data.created} new, ${r.data.duplicate} repeat, ${r.data.failed} failed`);
    onChanged();
  });
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success("Copied"), () => toast.error("Couldn't copy"));

  return (
    <Panel
      embedded={embedded}
      title={leadsOnly ? "Facebook lead forms" : "Meta app"}
      badge={<MetaStatusBadge status={i?.status ?? ads?.status ?? "none"} />}
      description={leadsOnly ? <>
        Only when this client&apos;s lead forms are on their own Facebook Page: connect that Page, and everyone who fills one of its
        forms lands in this client&apos;s CRM. {shared ? "The Page must be assigned to our system user in Meta Business settings." : "The Page must give the Meta app lead access (leads_retrieval)."}
      </> : <>
        One Meta app and token for both: the Page ID brings in lead forms, the ad account ID fills the Ads dashboard. Fill in either or both.
      </>}
    >
        <div className={cn("grid gap-2 rounded-lg border p-3 text-sm", !leadsOnly && "sm:grid-cols-2")}>
          <StatusLine label="Lead forms" status={i?.status ?? "none"}
            detail={i ? `${i.page_name ?? `Page ${i.page_id}`}${i.last_event_at ? ` · last lead ${formatDateTime(i.last_event_at)}` : ""}` : "Add a Page ID"} />
          {leadsOnly ? null : (
            <StatusLine label="Ads dashboard" status={ads?.status ?? "none"}
              detail={ads ? `${ads.name ?? `act_${ads.act_id}`}${ads.last_synced_at ? ` · synced ${formatDateTime(ads.last_synced_at)}` : ""}` : "Add an ad account ID"} />
          )}
        </div>
        {sharedApp ? (
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox checked={!ownApp} onCheckedChange={(v) => { setOwnApp(v !== true); setEdited(true); }} />
            Use our own Meta app and token (only the Page ID is needed)
          </Label>
        ) : null}
        <FieldGroup className="gap-4">
          <div className={cn("grid gap-4 sm:grid-cols-2", shared && "hidden")}>
            <Field>
              <FieldLabel htmlFor="meta-app">App ID</FieldLabel>
              <Input id="meta-app" inputMode="numeric" value={appId} onChange={(e) => edit(setAppId)(e.target.value)} placeholder="e.g. 1234567890123456" />
            </Field>
            <Field>
              <FieldLabel htmlFor="meta-secret">App secret</FieldLabel>
              <Input id="meta-secret" type="password" autoComplete="off" value={appSecret} onChange={(e) => edit(setAppSecret)(e.target.value)}
                placeholder={saved ? "•••••••• saved (type to replace)" : "From App settings → Basic"} />
            </Field>
          </div>
          <Field className={cn(shared && "hidden")}>
            <FieldLabel htmlFor="meta-token">System user access token</FieldLabel>
            <Input id="meta-token" type="password" autoComplete="off" value={token} onChange={(e) => edit(setToken)(e.target.value)}
              placeholder={saved ? "•••••••• saved (type to replace)" : leadsOnly ? "Never-expiring token with leads_retrieval" : "Never-expiring token with leads_retrieval and ads_read"} />
            <FieldDescription>
              Stored encrypted in Supabase Vault and never shown again. Already connected in another company? Paste the same token, App ID
              and secret; you don&apos;t need a new token, just assign this Page or ad account to the same system user.{" "}
              <Link href="/help/meta-lead-ads#tokens" target="_blank" className="underline underline-offset-2">Which use case and permissions</Link>
            </FieldDescription>
          </Field>
          <div className={cn("grid gap-4", !leadsOnly && "sm:grid-cols-2")}>
            <Field>
              <FieldLabel htmlFor="meta-page">Page ID <span className="font-normal text-muted-foreground">(lead forms)</span></FieldLabel>
              <Input id="meta-page" inputMode="numeric" value={pageId} onChange={(e) => edit(setPageId)(e.target.value)} placeholder="e.g. 102345678901234" />
            </Field>
            {leadsOnly ? null : (
              <Field>
                <FieldLabel htmlFor="meta-act">Ad account ID <span className="font-normal text-muted-foreground">(Ads dashboard)</span></FieldLabel>
                <Input id="meta-act" value={actId} onChange={(e) => edit(setActId)(e.target.value)} placeholder="act_1234567890" />
              </Field>
            )}
          </div>
        </FieldGroup>
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={saving || (shared ? !pageId : !appId || (!pageId && !actId))}>{saving ? <Loader2 className="animate-spin" /> : <Save />} Save</Button>
          {!dirty ? (
            <Button variant="outline" onClick={test} disabled={testing}>{testing ? <Loader2 className="animate-spin" /> : <PlugZap />} Connect &amp; test</Button>
          ) : null}
          {i ? <Button variant="outline" onClick={sync} disabled={syncing || i.status !== "connected"}>{syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync last 7 days of leads</Button> : null}
          {saved ? (
            <ConfirmDialog
              trigger={<Button variant="ghost"><Trash2 /> Remove</Button>}
              title="Remove the Facebook connection?"
              description={leadsOnly ? "New Facebook leads stop arriving. Existing leads stay. The saved secrets are deleted."
                : "New Facebook leads stop arriving and ad numbers stop syncing. Existing leads and synced ad history stay. The saved secrets are deleted."}
              confirmLabel="Remove" destructive
              onConfirm={async () => {
                const r = await removeFacebookConnection({ companyId: company.company_id });
                if (!r.ok) { toast.error(r.error); return false; }
                onChanged();
              }}
            />
          ) : null}
        </div>
        {saved && dirty ? <p className="text-xs text-muted-foreground">Save your changes to test them. Connect &amp; test checks what is saved.</p> : null}
        {dirty ? null : steps ? (
          <div className="space-y-3 rounded-lg border p-3 text-sm">
            {steps.leads ? <StepList title="Lead forms" steps={steps.leads} /> : null}
            {steps.ads ? <StepList title="Ads dashboard" steps={steps.ads} /> : null}
          </div>
        ) : (
          <>
            {i?.status === "error" && i.last_error ? <p className="text-sm text-red-300">Lead forms: {i.last_error}</p> : null}
            {ads?.status === "error" && ads.last_error ? <p className="text-sm text-red-300">Ads: {ads.last_error}</p> : null}
          </>
        )}
        {i ? (
          <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-xs">
            <p className="text-muted-foreground">Connect &amp; test registers these automatically. To set them by hand: Meta app → Webhooks → Page → <b>leadgen</b>.</p>
            <CopyRow label="Callback URL" value={webhookUrl(company.company_id)} onCopy={copy} />
            <CopyRow label="Verify token" value={i.verify_token} onCopy={copy} />
          </div>
        ) : null}
    </Panel>
  );
}

function StatusLine({ label, status, detail }: { label: string; status: NonNullable<MetaOverview["integration"]>["status"] | "none"; detail: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2"><span className="font-medium">{label}</span><MetaStatusBadge status={status} /></div>
      <p className="truncate text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function StepList({ title, steps }: { title: string; steps: ConnectStep[] }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
      <ol className="space-y-1.5">
        {steps.map((s) => (
          <li key={s.label} className="flex gap-2">
            {s.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-400" />}
            <span><span className="font-medium">{s.label}</span>{s.detail ? <span className="block break-all text-xs text-muted-foreground">{s.detail}</span> : null}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A Card on its own page; plain content inside the Automation dialog's tabs. */
function Panel({ embedded, title, badge, description, children }: {
  embedded?: boolean; title: string; badge?: React.ReactNode; description: React.ReactNode; children: React.ReactNode;
}) {
  if (embedded) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{description}</p>
        {children}
      </div>
    );
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{title}</CardTitle>
          {badge}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate">{value}</code>
      <Button variant="ghost" size="icon-sm" onClick={() => onCopy(value)} aria-label={`Copy ${label}`}><Copy /></Button>
    </div>
  );
}

export function RoutingCard({ company, onChanged, embedded, emptyText = "Nobody selected: leads go to the company's admin." }: {
  company: MetaOverview; onChanged: () => void; embedded?: boolean; emptyText?: string;
}) {
  const [picked, setPicked] = useState<string[]>(company.routing);
  const [pending, start] = useTransition();
  const dirty = picked.slice().sort().join() !== company.routing.slice().sort().join();
  const save = () => start(async () => {
    const r = await setMetaRouting({ companyId: company.company_id, userIds: picked });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Lead routing saved");
    onChanged();
  });
  return (
    <Panel
      embedded={embedded}
      title="Who gets new Facebook leads"
      description={picked.length === 0 ? emptyText
        : picked.length === 1 ? "One person selected: every lead goes to them."
        : `${picked.length} people selected: leads are shared round-robin, one each in turn.`}
    >
        {company.candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">This company has no active sales users yet. Add them under Users.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {company.candidates.map((u) => (
              <Label key={u.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 font-normal">
                <Checkbox checked={picked.includes(u.id)} onCheckedChange={(v) => setPicked((p) => (v === true ? [...p, u.id] : p.filter((x) => x !== u.id)))} />
                <span className="flex-1">{u.display_name}</span>
                <span className="text-xs text-muted-foreground">{u.ours ? "Our team" : u.role === "admin" ? "Admin" : "Sales"}</span>
              </Label>
            ))}
          </div>
        )}
        <Button onClick={save} disabled={pending || !dirty}>{pending ? <Loader2 className="animate-spin" /> : <Save />} Save routing</Button>
        <p className="text-xs text-muted-foreground">Last 7 days: {company.leads_7d} new leads{company.failed_7d ? `, ${company.failed_7d} failed` : ""}.</p>
    </Panel>
  );
}

const STATE_TEXT: Record<string, [string, string]> = {
  created: ["New lead", "text-emerald-300"],
  duplicate: ["Repeat (noted)", "text-sky-300"],
  failed: ["Failed", "text-red-300"],
  received: ["Waiting", "text-amber-300"],
};

export function InboxCard({ companyId, embedded }: { companyId: string; embedded?: boolean }) {
  const events = useLiveQuery({
    queryKey: `meta-events:${companyId}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("super_meta_events", { p_company_id: companyId, p_limit: 50 }).abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as MetaEvent[];
    },
    tables: ["leads"],
  });
  return (
    <Panel embedded={embedded} title="Recent Facebook leads" description="The last 50 lead events from Meta for this company.">
        {!events.data ? <ListSkeleton rows={3} /> : events.data.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet. Send a test lead with Meta&apos;s Lead Ads Testing Tool.</p> : (
          <ul className="max-h-96 divide-y overflow-y-auto rounded-lg border">
            {events.data.map((e) => (
              <li key={e.id} className="px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  {e.lead_id ? <Link href={`/leads/${e.lead_id}`} className="truncate font-medium hover:underline">{e.lead_name ?? "Lead"}</Link> : <span className="text-muted-foreground">—</span>}
                  <span className={cn("shrink-0 text-xs", STATE_TEXT[e.state]?.[1])}>{STATE_TEXT[e.state]?.[0] ?? e.state}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(e.created_at)}{e.form_name ? ` · ${e.form_name}` : ""}{e.owner ? ` · to ${e.owner}` : ""}{e.crm ? ` · in ${e.crm}'s CRM` : ""}
                </p>
                {e.error ? <p className="text-xs text-red-300">{e.error}</p> : null}
              </li>
            ))}
          </ul>
        )}
    </Panel>
  );
}
