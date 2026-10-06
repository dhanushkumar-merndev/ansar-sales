"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound, Loader2, Pencil, Plus, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import { AdAccountForm, AdAccountStatus } from "@/components/ads/ad-account-form";
import { clientStatusTone } from "@/components/ads/ads-clients-view";
import { AdsDashboard } from "@/components/ads/ads-dashboard";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { type AdAccount, type AdsClient, ADS_CLIENT_STATUS_LABELS, type AdsClientStatus } from "@/lib/ads";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  createClientLogin, resetClientPassword, setAdsClientStatus, setClientLoginActive, updateAdsClient,
} from "@/server/actions/ads";

type Login = { id: string; username: string; display_name: string; is_active: boolean; created_at: string };
type Detail = AdsClient & { company_name: string; accounts: AdAccount[]; logins: Login[] };

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
  const [accountId, setAccountId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const c = detail.data;
  if (detail.error && !c) return <ErrorState message={detail.error} onRetry={detail.refetch} />;
  if (!c) return <ListSkeleton rows={8} />;
  const live = c.accounts.find((a) => !a.archived_at) ?? null;
  const shown = c.accounts.find((a) => a.id === accountId) ?? live ?? c.accounts[0] ?? null;

  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" asChild className="-ml-2"><Link href="/ads/clients"><ArrowLeft /> All clients</Link></Button>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight md:text-2xl">
            {c.name}
            <Badge variant="outline" className={cn(clientStatusTone(c.status))}>{ADS_CLIENT_STATUS_LABELS[c.status]}</Badge>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[c.business, c.phone, c.email].filter(Boolean).join(" · ") || "No contact details"} · client since {formatDate(c.started_at)}
            {c.closed_at ? ` · closed ${formatDate(c.closed_at)}` : ""}
            {c.lead_id && profile.role === "admin" ? <> · <Link href={`/leads/${c.lead_id}`} className="underline underline-offset-2">original lead</Link></> : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusSelect client={c} onChanged={detail.refetch} />
          <Button variant="outline" onClick={() => setEditing(true)}><Pencil /> Edit</Button>
        </div>
      </div>
      {c.notes ? <p className="max-w-3xl text-sm whitespace-pre-wrap text-muted-foreground">{c.notes}</p> : null}

      <Tabs defaultValue={shown ? "results" : "connection"}>
        <TabsList>
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="connection">Meta connection</TabsTrigger>
          <TabsTrigger value="login">Client login</TabsTrigger>
        </TabsList>
        <TabsContent value="results" className="pt-3">
          {!shown ? (
            <EmptyState title="No ad account yet" description="Connect the client's Meta app and ad account on the Meta connection tab." />
          ) : (
            <div className="space-y-4">
              {c.accounts.length > 1 ? (
                <Select value={shown.id} onValueChange={setAccountId}>
                  <SelectTrigger className="w-80" aria-label="Ad account"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {c.accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name ?? `act_${a.act_id}`}{a.archived_at ? " · earlier account (history)" : ""}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : null}
              {c.status === "closed" ? <p className="text-sm text-muted-foreground">This client is closed: syncing stopped, and everything synced until then is kept below.</p> : null}
              <AdsDashboard key={shown.id} accountId={shown.id} canManage />
            </div>
          )}
        </TabsContent>
        <TabsContent value="connection" className="pt-3">
          <Card className="max-w-2xl">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>The client&apos;s Meta app</CardTitle>
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
        <TabsContent value="login" className="pt-3">
          <LoginsCard client={c} onChanged={detail.refetch} />
        </TabsContent>
      </Tabs>
      <EditClientDialog open={editing} onOpenChange={setEditing} client={c} onSaved={detail.refetch} />
    </div>
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
            <DialogTitle>Close {client.name}?</DialogTitle>
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
  return (
    <div className="grid max-w-4xl gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Client portal logins</CardTitle>
          <CardDescription>The client signs in on the same login page and sees only their own ad results, read-only.</CardDescription>
        </CardHeader>
        <CardContent>
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
  const [form, setForm] = useState({ name: client.name, business: client.business ?? "", phone: client.phone ?? "", email: client.email ?? "", notes: client.notes ?? "" });
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
            <Field><FieldLabel htmlFor="ec-name">Name</FieldLabel><Input id="ec-name" value={form.name} onChange={set("name")} required maxLength={120} /></Field>
            <Field><FieldLabel htmlFor="ec-business">Business</FieldLabel><Input id="ec-business" value={form.business} onChange={set("business")} maxLength={120} /></Field>
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
