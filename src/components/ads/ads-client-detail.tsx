"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronsUpDown, Info, KeyRound, Loader2, Pencil, Plus, RefreshCw, Trash2, Unlink, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import { AdAccountForm, AdAccountStatus } from "@/components/ads/ad-account-form";
import { clientStatusTone } from "@/components/ads/ads-clients-view";
import { ClientResults, defaultRange, type ResultSource } from "@/components/ads/client-results";
import { pastPresets, RangePicker, type DayRange } from "@/components/common/range-picker";
import { AddCampaigns } from "@/components/ads/ads-view";
import { ConnectionCard, InboxCard, type MetaOverview, RoutingCard } from "@/components/automation/facebook-leads";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { StatCard } from "@/components/dashboard/widgets";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useShowMore } from "@/hooks/use-show-more";
import { type AdAccount, type AdsClient, ADS_CLIENT_STATUS_LABELS, type AdsClientStatus, type AgencySource } from "@/lib/ads";
import { createClient } from "@/lib/supabase/client";
import { formatCount } from "@/lib/format";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  createClientLogin, deleteAdsClient, openAdsClientCrm, resetClientPassword, saveAdCategory, setAdsClientCategory, setAdsClientStatus, setClientLoginActive, setClientPortalLeads,
  updateAdsClient,
} from "@/server/actions/ads";
import { connectClientPage, syncClientLeads } from "@/server/actions/meta";

type Login = { id: string; username: string; display_name: string; is_active: boolean; created_at: string };
type AgencyCategory = { id: string; name: string; company_id: string | null; ads_client_id: string | null; client_name: string | null };
type Detail = AdsClient & {
  /** Our own company (the agency running this client's ads). */
  agency_name: string; accounts: AdAccount[]; logins: Login[];
  /** The company's own live ad account, with its categories for linking (null when not connected). */
  agency: { account: AdAccount; categories: AgencyCategory[] } | null;
  /** Categories of company ad accounts run for this client (disconnected accounts included, for history). */
  agency_sources: AgencySource[];
};

/** Counts from the client's own CRM (null until it is created). */
type CrmSummary = {
  company_id: string; name: string; archived: boolean;
  active_leads: number; new_today: number; won_this_month: number; due_today: number; overdue: number; users: number;
};

const accountLabel = (a: AdAccount) => a.name ?? `act_${a.act_id}`;

/** Every source of results, agency categories first; earlier accounts are marked as history. */
function resultSources(c: Detail): ResultSource[] {
  return [
    ...(c.agency_sources ?? []).map((s) => ({
      accountId: s.account.id, categoryId: s.category_id,
      label: `Our account · ${s.category_name}${s.account.archived_at ? " · earlier account (history)" : ""}`,
    })),
    ...c.accounts.map((a) => ({
      accountId: a.id, categoryId: null,
      label: `Client's account · ${accountLabel(a)}${a.archived_at ? " · earlier account (history)" : ""}`,
    })),
  ];
}

export function AdsClientDetail({ id }: { id: string }) {
  const profile = useProfile();
  const detail = useLiveQuery({
    queryKey: `ads-client:${id}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("ads_client_detail", { p_id: id }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as Detail;
    },
    pollMs: 5 * 60_000,
  });
  const [editing, setEditing] = useState(false);
  const [syncSlot, setSyncSlot] = useState<HTMLElement | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [range, setRange] = useState<DayRange>(defaultRange);
  const c = detail.data;
  if (detail.error && !c) return <ErrorState message={detail.error} onRetry={detail.refetch} />;
  if (!c) return <ListSkeleton rows={8} />;
  const live = c.accounts.find((a) => !a.archived_at) ?? null;
  const linked = (c.agency_sources ?? []).find((s) => !s.account.archived_at) ?? null;
  const sources = resultSources(c);
  const activeTab = tab ?? (sources.length ? "results" : "accounts");

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" asChild className="-ml-2"><Link href="/ads/clients"><ArrowLeft /> All clients</Link></Button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight md:text-2xl">
            {c.company_name ?? c.name}
            <Badge variant="outline" className={cn(clientStatusTone(c.status))}>{ADS_CLIENT_STATUS_LABELS[c.status]}</Badge>
            <SourceBadges agency={Boolean(linked)} own={Boolean(live)} />
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[c.company_name ? c.name : null, c.business, c.phone, c.email].filter(Boolean).join(" · ") || "No contact details"} · client since {formatDate(c.started_at)}
            {c.closed_at ? ` · closed ${formatDate(c.closed_at)}` : ""}
            {c.lead_id && profile.role === "admin" ? <> · <Link href={`/leads/${c.lead_id}`} className="underline underline-offset-2">original lead</Link></> : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusSelect client={c} onChanged={detail.refetch} />
          <Button variant="outline" onClick={() => setEditing(true)}><Pencil /> Edit</Button>
          {profile.isSuperAdmin ? <DeleteClientButton client={c} /> : null}
          <div ref={setSyncSlot} className="flex items-center gap-2" />
        </div>
      </div>
      {c.notes ? <p className="max-w-3xl text-sm whitespace-pre-wrap text-muted-foreground">{c.notes}</p> : null}

      <Tabs value={activeTab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="results">Results</TabsTrigger>
            <TabsTrigger value="accounts">Ad accounts</TabsTrigger>
            <TabsTrigger value="leads">Leads</TabsTrigger>
            <TabsTrigger value="login">Client login</TabsTrigger>
          </TabsList>
          {activeTab === "results" && sources.length ? (
            <RangePicker value={range} onChange={(r) => r && setRange(r)} presets={pastPresets()} ariaLabel="Ads date range" align="end" />
          ) : null}
        </div>
        <TabsContent value="results" className="pt-3">
          {!sources.length ? (
            <EmptyState title="No ad source yet"
              description="On the Ad accounts tab, run this client's ads on our own ad account, connect the client's own ad account, or both." />
          ) : (
            <div className="space-y-4">
              {c.status === "closed" ? <p className="text-sm text-muted-foreground">This client is closed: syncing stopped, and everything synced until then is kept below.</p> : null}
              <ClientResults clientId={c.id} sources={sources} canManage range={range} syncSlot={syncSlot} />
            </div>
          )}
        </TabsContent>
        <TabsContent value="accounts" className="space-y-4 pt-3">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Set up at least one before the client goes Active. With both, Results adds them up and lets you open each one.
          </p>
          <AgencyCard client={c} linked={linked} onChanged={detail.refetch} />
          <Card className="max-w-2xl">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>The client&apos;s own ad account</CardTitle>
                <AdAccountStatus account={live} />
              </div>
              <CardDescription>
                The client creates their own Meta app and a system user token with ads_read, and assigns their ad account to it.
                Paste the details here; the CRM keeps them encrypted and syncs every hour.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AdAccountForm key={live?.id ?? "new"} kind="client" ownerId={c.id} account={live} onChanged={detail.refetch} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="leads" className="pt-3">
          <ClientCrmCard client={c} />
        </TabsContent>
        <TabsContent value="login" className="space-y-4 pt-3">
          <LoginsCard client={c} onChanged={detail.refetch} />
          <p className="max-w-4xl text-sm text-muted-foreground">
            These logins only show ad results. CRM users for the client&apos;s staff are added inside their CRM → Users (open it from the Leads tab).
          </p>
        </TabsContent>
      </Tabs>
      <EditClientDialog open={editing} onOpenChange={setEditing} client={c} onSaved={detail.refetch} />
    </div>
  );
}

/** The client's own leads CRM: created on first use, then opened by switching into it. */
function ClientCrmCard({ client }: { client: Detail }) {
  const [pending, start] = useTransition();
  const summary = useLiveQuery({
    queryKey: `ads-client-crm:${client.id}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("ads_client_crm_summary", { p_client: client.id }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as CrmSummary | null;
    },
  });
  const open = () => start(async () => {
    const r = await openAdsClientCrm({ clientId: client.id });
    if (!r.ok) { toast.error(r.error); return; }
    // A full load: every list, cache and Realtime channel then belongs to the client's CRM.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/leads");
  });
  const s = summary.data;
  const name = client.company_name ?? client.name;
  if (summary.error && s === undefined) return <ErrorState message={summary.error} onRetry={summary.refetch} />;
  if (s === undefined) return <ListSkeleton rows={3} />;
  if (!s) {
    return (
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>A leads CRM for {name}</CardTitle>
          <CardDescription>
            Gives this client their own leads, follow-ups, timeline and Telegram reminders, kept apart from ours.
            Our admins and ads managers work in it as Admin; the client&apos;s staff get their own users inside it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={open} disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : <Plus />} Create &amp; open CRM</Button>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{s.name}</span> · {formatCount(s.users)} {s.users === 1 ? "user" : "users"} of their own
          {s.archived ? " · archived" : ""}
        </p>
        <Button onClick={open} disabled={pending || s.archived}>Open CRM {pending ? <Loader2 className="animate-spin" /> : <ArrowRight />}</Button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard label="Active leads" value={formatCount(s.active_leads)} />
        <StatCard label="New today" value={formatCount(s.new_today)} />
        <StatCard label="Due today" value={formatCount(s.due_today)} hint="Follow-ups still to do today" />
        <StatCard label="Overdue" value={formatCount(s.overdue)} tone={s.overdue ? "danger" : undefined} hint="Follow-ups past their time" />
        <StatCard label="Won this month" value={formatCount(s.won_this_month)} tone={s.won_this_month ? "success" : undefined} />
      </div>
      {s.archived ? null : <ClientFacebookLeads clientId={client.id} onChanged={summary.refetch} />}
    </div>
  );
}

/** The client's Facebook Page connected to their CRM, who gets its leads, and the latest ones. */
function ClientFacebookLeads({ clientId, onChanged }: { clientId: string; onChanged: () => void }) {
  const [syncing, startSync] = useTransition();
  const meta = useLiveQuery({
    queryKey: `ads-client-crm-meta:${clientId}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("ads_client_crm_meta", { p_client: clientId }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as MetaOverview | null;
    },
    tables: ["profiles"],
    pollMs: 0,
  });
  const m = meta.data;
  if (meta.error && !m) return <ErrorState message={meta.error} onRetry={meta.refetch} />;
  if (m === undefined) return <ListSkeleton rows={4} />;
  if (!m) return null;
  const changed = () => { meta.refetch(); onChanged(); };
  const ours = m.agency ?? null;
  const sync = () => startSync(async () => {
    const r = await syncClientLeads({ clientId });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(r.data.routed
      ? `${r.data.routed} new ${r.data.routed === 1 ? "lead" : "leads"} added to this CRM`
      : `Checked ${r.data.found} leads from the last 7 days: nothing new for this client`);
    changed();
  });
  const ourPage = ours ? (ours.page_name ?? `Page ${ours.page_id}`) : "";
  return (
    <div className="space-y-4 pt-2">
      {!ours ? null : ours.status === "connected" && ours.categories.length ? (
        <p className="flex items-start gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/5 p-3 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <span className="flex-1">
            <span className="font-medium">Automatic.</span> Leads from the campaigns in {ours.categories.map((n) => `“${n}”`).join(", ")} on our ad account
            arrive in this CRM through our own Facebook connection ({ourPage}). Nothing to connect for those.
            <span className="block text-xs text-muted-foreground">
              A new campaign counts once it is in the client&apos;s category, which happens at the next hourly ad sync. Sync now picks up the
              last 7 days of leads (for example ones Facebook couldn&apos;t deliver); a lead that already landed in our own Leads stays there.
            </span>
          </span>
          <Button size="sm" variant="outline" className="shrink-0" onClick={sync} disabled={syncing}>
            {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync now
          </Button>
        </p>
      ) : (
        <p className="flex items-start gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>
            {ours.status !== "connected"
              ? <>Our own Facebook connection ({ourPage}) isn&apos;t working, so campaign leads can&apos;t arrive by themselves. Fix it under Automation.</>
              : <>To get this client&apos;s leads by themselves, run their campaigns in a category on our ad account (Ad accounts tab). Leads from those campaigns then arrive here through our own Facebook connection ({ourPage}).</>}
          </span>
        </p>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ConnectionCard key={`c-${m.integration?.page_id ?? "new"}`} company={m} adAccount={null} onChanged={changed} leadsOnly
          sharedApp={ours ? { appId: ours.app_id, save: (pageId) => connectClientPage({ clientId, pageId }) } : undefined} />
        <div className="space-y-6">
          <RoutingCard key={`r-${m.routing.join(",")}`} company={m} onChanged={meta.refetch}
            emptyText="Nobody selected: leads go to the client's admin, or to whoever on our team created this CRM." />
          <InboxCard companyId={m.company_id} />
        </div>
      </div>
    </div>
  );
}

/** Super admin: soft delete. The client moves to Ads → Clients → Deleted, where it can be restored or exported and removed for good. */
function DeleteClientButton({ client }: { client: Detail }) {
  const router = useRouter();
  const name = client.company_name ?? client.name;
  return (
    <ConfirmDialog
      trigger={<Button variant="outline" className="text-destructive"><Trash2 /> Delete</Button>}
      title={`Delete ${name}?`}
      description={<>
        The client disappears from the Ads pages. It is closed, its ad syncing stops, its logins are turned off and its client CRM is closed.
        Nothing is erased yet: under Clients → <b>Deleted</b> you can restore it, or download everything as Excel and then delete it for good.
      </>}
      confirmLabel="Delete client"
      destructive
      onConfirm={async () => {
        const r = await deleteAdsClient({ id: client.id });
        if (!r.ok) { toast.error(r.error); return false; }
        toast.success(`${name} deleted. Restore or remove it for good under Clients → Deleted.`);
        router.push("/ads/clients");
      }}
    />
  );
}

function StatusSelect({ client, onChanged }: { client: Detail; onChanged: () => void }) {
  const [pending, start] = useTransition();
  const [closing, setClosing] = useState(false);
  const [disableLogins, setDisableLogins] = useState(true);
  const apply = (status: AdsClientStatus, disable = true) => start(async () => {
    const r = await setAdsClientStatus({ id: client.id, status, disableLogins: disable });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(status === "closed" ? "Client closed. Their history stays here." : `Marked ${ADS_CLIENT_STATUS_LABELS[status].toLowerCase()}`);
    onChanged();
  });
  return (
    <>
      <Select value={client.status} disabled={pending} onValueChange={(v) => (v === "closed" ? setClosing(true) : apply(v as AdsClientStatus))}>
        <SelectTrigger className="w-40" aria-label="Client status"><SelectValue /></SelectTrigger>
        <SelectContent>{Object.entries(ADS_CLIENT_STATUS_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
      </Select>
      <Dialog open={closing} onOpenChange={setClosing}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Close {client.company_name ?? client.name}?</DialogTitle>
            <DialogDescription>Syncing stops. Every number synced so far stays in the CRM. You can reopen the client later.</DialogDescription>
          </DialogHeader>
          {client.logins.some((l) => l.is_active) ? (
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox checked={disableLogins} onCheckedChange={(v) => setDisableLogins(v === true)} /> Also turn off the client&apos;s login
            </Label>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setClosing(false)}>Cancel</Button>
            <Button variant="destructive" disabled={pending} onClick={() => { setClosing(false); apply("closed", disableLogins); }}>Close client</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function LoginsCard({ client, onChanged }: { client: Detail; onChanged: () => void }) {
  const [form, setForm] = useState({ username: "", displayName: client.name, password: "" });
  const [pending, start] = useTransition();
  const [resetFor, setResetFor] = useState<Login | null>(null);
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await createClientLogin({ clientId: client.id, ...form });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Login created. Share the username and password with the client.");
      setForm({ username: "", displayName: client.name, password: "" });
      onChanged();
    });
  };
  const toggle = (l: Login) => start(async () => {
    const r = await setClientLoginActive({ id: l.id, isActive: !l.is_active });
    if (!r.ok) { toast.error(r.error); return; }
    onChanged();
  });
  const showLeads = (on: boolean) => start(async () => {
    const r = await setClientPortalLeads({ clientId: client.id, on });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(on ? "The portal now lists their leads too." : "The portal shows ad results only.");
    onChanged();
  });
  return (
    <div className="grid max-w-4xl gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Client portal logins</CardTitle>
          <CardDescription>The client signs in on the same login page and sees their own ad results, and their leads if switched on below. All read-only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <Label htmlFor="portal-leads" className="text-sm font-medium">Also show their leads (view only)</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {client.has_crm
                  ? "The leads in their CRM: name, contact, stage and date. No notes, owners or follow-ups."
                  : "Create the client's CRM first (Leads tab)."}
              </p>
            </div>
            <Switch id="portal-leads" checked={client.portal_show_leads} onCheckedChange={showLeads}
              disabled={pending || (!client.has_crm && !client.portal_show_leads)} />
          </div>
          {client.logins.length === 0 ? <p className="text-sm text-muted-foreground">No login yet.</p> : (
            <ul className="divide-y rounded-lg border">
              {client.logins.map((l) => (
                <li key={l.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{l.username}</div>
                    <div className="text-xs text-muted-foreground">{l.display_name} · since {formatDate(l.created_at)}</div>
                  </div>
                  <Badge variant="outline" className={l.is_active ? "border-emerald-400/30 text-emerald-300" : "text-muted-foreground"}>{l.is_active ? "Active" : "Off"}</Badge>
                  <Button variant="ghost" size="icon-sm" aria-label={`Reset password for ${l.username}`} onClick={() => setResetFor(l)}><KeyRound /></Button>
                  {l.is_active ? (
                    <ConfirmDialog
                      trigger={<Button variant="ghost" size="icon-sm" aria-label={`Turn off ${l.username}`}><UserX /></Button>}
                      title={`Turn off ${l.username}?`} description="They can no longer sign in. You can turn it back on." confirmLabel="Turn off" destructive
                      onConfirm={async () => { toggle(l); }}
                    />
                  ) : (
                    <Button variant="ghost" size="icon-sm" aria-label={`Turn on ${l.username}`} onClick={() => toggle(l)} disabled={pending}><UserCheck /></Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>New login</CardTitle>
          <CardDescription>Give these to the client. Usernames are unique across the whole CRM.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="space-y-4">
            <FieldGroup className="gap-4">
              <Field><FieldLabel htmlFor="cl-user">Username</FieldLabel><Input id="cl-user" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" required /></Field>
              <Field><FieldLabel htmlFor="cl-name">Name shown</FieldLabel><Input id="cl-name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required maxLength={80} /></Field>
              <Field>
                <FieldLabel htmlFor="cl-pass">Password</FieldLabel>
                <Input id="cl-pass" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" required minLength={8} maxLength={72} />
                <FieldDescription>At least 8 characters.</FieldDescription>
              </Field>
            </FieldGroup>
            <Button type="submit" disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : <Plus />} Create login</Button>
          </form>
        </CardContent>
      </Card>
      <ResetPasswordDialog login={resetFor} onClose={() => setResetFor(null)} />
    </div>
  );
}

function ResetPasswordDialog({ login, onClose }: { login: Login | null; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog open={Boolean(login)} onOpenChange={(o) => { if (!o) { onClose(); setPassword(""); } }}>
      <DialogContent className="sm:max-w-sm">
        <form className="grid gap-4" onSubmit={(e) => {
          e.preventDefault();
          if (!login) return;
          start(async () => {
            const r = await resetClientPassword({ id: login.id, password });
            if (!r.ok) { toast.error(r.error); return; }
            toast.success("Password changed");
            setPassword("");
            onClose();
          });
        }}>
          <DialogHeader>
            <DialogTitle>New password for {login?.username}</DialogTitle>
            <DialogDescription>Share it with the client privately.</DialogDescription>
          </DialogHeader>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} maxLength={72} required aria-label="New password" />
          <DialogFooter><Button type="submit" disabled={pending || password.length < 8}>{pending ? <Loader2 className="animate-spin" /> : null} Save password</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditClientDialog({ open, onOpenChange, client, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; client: Detail; onSaved: () => void }) {
  const [form, setForm] = useState({ companyName: client.company_name ?? "", name: client.name, business: client.business ?? "", phone: client.phone ?? "", email: client.email ?? "", notes: client.notes ?? "" });
  const [pending, start] = useTransition();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-5" onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await updateAdsClient({ id: client.id, ...form });
            if (!r.ok) { toast.error(r.error); return; }
            onOpenChange(false);
            onSaved();
          });
        }}>
          <DialogHeader><DialogTitle>Edit client</DialogTitle><DialogDescription>Contact details and notes for the ads team.</DialogDescription></DialogHeader>
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="ec-company">Company name</FieldLabel><Input id="ec-company" value={form.companyName} onChange={set("companyName")} maxLength={120} /></Field>
              <Field><FieldLabel htmlFor="ec-name">Contact name</FieldLabel><Input id="ec-name" value={form.name} onChange={set("name")} required maxLength={120} /></Field>
            </div>
            <Field><FieldLabel htmlFor="ec-business">Industry</FieldLabel><Input id="ec-business" value={form.business} onChange={set("business")} maxLength={120} placeholder="e.g. Real estate" /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="ec-phone">Phone</FieldLabel><Input id="ec-phone" value={form.phone} onChange={set("phone")} maxLength={32} /></Field>
              <Field><FieldLabel htmlFor="ec-email">Email</FieldLabel><Input id="ec-email" type="email" value={form.email} onChange={set("email")} maxLength={254} /></Field>
            </div>
            <Field><FieldLabel htmlFor="ec-notes">Notes</FieldLabel><Textarea id="ec-notes" value={form.notes} onChange={set("notes")} maxLength={2000} rows={4} /></Field>
          </FieldGroup>
          <DialogFooter><Button type="submit" disabled={pending || !form.name.trim()}>{pending ? <Loader2 className="animate-spin" /> : null} Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SourceBadges({ agency, own }: { agency: boolean; own: boolean }) {
  if (!agency && !own) return <Badge variant="outline" className="border-red-400/30 text-red-300">No ad source</Badge>;
  return (
    <>
      {agency ? <Badge variant="outline" className="text-muted-foreground">Our account</Badge> : null}
      {own ? <Badge variant="outline" className="text-muted-foreground">Own account</Badge> : null}
    </>
  );
}

/** Runs the client's ads on the company's own ad account: one category of it is linked to the client. */
function AgencyCard({ client, linked, onChanged }: { client: Detail; linked: AgencySource | null; onChanged: () => void }) {
  const agency = client.agency;
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Our ad account{agency ? ` · ${accountLabel(agency.account)}` : ""}</CardTitle>
          {linked ? <Badge variant="outline" className="border-emerald-400/30 text-emerald-300">In use</Badge>
            : <Badge variant="outline" className="text-muted-foreground">Not used</Badge>}
        </div>
        <CardDescription>
          Run this client&apos;s campaigns on {client.agency_name}&apos;s own ad account. The campaigns in the client&apos;s category count as theirs;
          their login sees only those.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!agency ? (
          <p className="text-sm text-muted-foreground">
            {client.agency_name} has no ad account connected. Connect it on the <Link href="/ads" className="underline underline-offset-2">Ads</Link> page first.
          </p>
        ) : linked ? (
          <LinkedCategory client={client} source={linked} onChanged={onChanged} />
        ) : (
          <CategoryLinker client={client} categories={agency.categories} onChanged={onChanged} />
        )}
      </CardContent>
    </Card>
  );
}

function LinkedCategory({ client, source, onChanged }: { client: Detail; source: AgencySource; onChanged: () => void }) {
  const [match, setMatch] = useState(source.match_text ?? "");
  const [pending, start] = useTransition();
  const saveMatch = () => {
    if ((source.match_text ?? "") === match.trim()) return;
    start(async () => {
      const r = await saveAdCategory({ accountId: source.account.id, id: source.category_id, name: source.category_name, matchText: match });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Saved; matching campaigns were filed");
      onChanged();
    });
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Category</span>
        <span className="font-medium">{source.category_name}</span>
        <span className="text-xs text-muted-foreground">· {source.campaigns ?? 0} campaigns</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={match} onChange={(e) => setMatch(e.target.value)} onBlur={saveMatch} disabled={pending} maxLength={60}
          placeholder="Match text, e.g. MEHTA" className="h-8 w-56" aria-label="Match text" />
        <AddCampaigns accountId={source.account.id} category={{ id: source.category_id, name: source.category_name }} onChanged={onChanged} />
        <ConfirmDialog
          trigger={<Button variant="ghost" size="sm"><Unlink /> Stop using</Button>}
          title="Stop running this client on our ad account?"
          description={`"${source.category_name}" stays on the ad account with its campaigns, but stops counting for ${client.company_name ?? client.name} and their login loses access to it.`}
          confirmLabel="Stop using" destructive
          onConfirm={async () => {
            const r = await setAdsClientCategory({ clientId: client.id, categoryId: null });
            if (!r.ok) { toast.error(r.error); return false; }
            toast.success("No longer using our ad account for this client");
            onChanged();
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">New campaigns whose name contains the match text are filed here on every sync.</p>
    </div>
  );
}

/** Pick an existing category of the agency account, or create one named after the client. */
function CategoryLinker({ client, categories, onChanged }: { client: Detail; categories: AgencyCategory[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [pending, start] = useTransition();
  const newName = client.company_name ?? client.business ?? client.name;
  const term = input.trim().toLowerCase();
  const isTaken = (k: AgencyCategory) => Boolean(k.company_id || (k.ads_client_id && k.ads_client_id !== client.id));
  // Free categories first; with hundreds of clients only the first 50 matches are drawn.
  const options = categories.filter((k) => !term || k.name.toLowerCase().includes(term))
    .sort((a, b) => Number(isTaken(a)) - Number(isTaken(b)));
  const paging = useShowMore(options.length, input);
  const exists = categories.some((k) => k.name.toLowerCase() === newName.trim().toLowerCase());
  const link = (args: { categoryId?: string; create?: boolean }) => start(async () => {
    const r = await setAdsClientCategory({ clientId: client.id, ...args });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Now running this client on our ad account");
    setOpen(false);
    onChanged();
  });
  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <PopoverTrigger asChild>
          <Button variant="outline" role="combobox" aria-expanded={open} disabled={pending} className="w-72 max-w-full justify-between font-normal">
            {pending ? <Loader2 className="animate-spin" /> : null}
            <span className="truncate text-muted-foreground">Choose or create the client&apos;s category</span>
            <ChevronsUpDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search categories…" value={input} onValueChange={setInput} maxLength={60} />
            <CommandList onScroll={paging.onScroll}>
              {options.length === 0 && exists ? <CommandEmpty>No categories found.</CommandEmpty> : null}
              <CommandGroup>
                {!exists ? (
                  <CommandItem value="create" onSelect={() => link({ create: true })}>
                    <Plus className="size-4" /> Create &ldquo;{newName}&rdquo;
                  </CommandItem>
                ) : null}
                {options.slice(0, paging.count).map((k) => {
                  const taken = isTaken(k);
                  return (
                    <CommandItem key={k.id} value={k.id} disabled={taken} onSelect={() => link({ categoryId: k.id })}>
                      <Check className="size-4 opacity-0" />
                      <span className="min-w-0 flex-1 truncate">{k.name}</span>
                      {taken ? <span className="text-xs text-muted-foreground">{k.company_id ? "Company" : k.client_name}</span> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              {paging.more ? <p className="px-3 py-2 text-xs text-muted-foreground">Scroll for {formatCount(paging.more)} more</p> : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p className="text-xs text-muted-foreground">Then file its campaigns with match text or &ldquo;Add campaigns&rdquo;.</p>
    </div>
  );
}
