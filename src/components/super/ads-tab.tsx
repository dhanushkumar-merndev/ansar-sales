"use client";

import { useState, useTransition } from "react";
import { KeyRound, Loader2, Plus, Save, UserCheck, UserX } from "lucide-react";
import { toast } from "sonner";
import { AdAccountStatus } from "@/components/ads/ad-account-form";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorState, ListSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLiveQuery } from "@/hooks/use-live-query";
import type { AdAccount } from "@/lib/ads";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/time";
import { createAdsManager, mergeAdAccount, resetAdsManagerPassword, setAdsManagerCompanies, updateAdsManager } from "@/server/actions/ads";

type AdsManager = { id: string; username: string; display_name: string; is_active: boolean; created_at: string; company_ids: string[] };
type CompanyAds = { company_id: string; company_name: string; won_to_ads_client: boolean; account: AdAccount | null; members: string[]; member_of: string | null };

/** Super admin: ads managers and the companies each handles, and sharing one company's ad account. */
export function AdsTab() {
  const managers = useLiveQuery({
    queryKey: "super-ads-managers",
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("super_list_ads_managers").abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as unknown as AdsManager[];
    },
    pollMs: 0,
  });
  const overview = useLiveQuery({
    queryKey: "super-ads-overview",
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("super_ads_overview").abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as unknown as CompanyAds[];
    },
    pollMs: 0,
  });
  const [adding, setAdding] = useState(false);
  if ((managers.error && !managers.data) || (overview.error && !overview.data)) {
    return <ErrorState message={managers.error ?? overview.error ?? ""} onRetry={() => { managers.refetch(); overview.refetch(); }} />;
  }
  if (!managers.data || !overview.data) return <ListSkeleton rows={6} />;
  const companies = overview.data;
  const name = (id: string) => companies.find((c) => c.company_id === id)?.company_name ?? "Archived company";

  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Ads managers</CardTitle>
            <Button size="sm" onClick={() => setAdding(true)}><Plus /> Add ads manager</Button>
          </div>
          <CardDescription>
            Ads managers see only Ads and Ads clients, never leads, finance or users. Tick the companies each one handles;
            they switch between them at the top left.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {managers.data.length === 0 ? <p className="text-sm text-muted-foreground">No ads managers yet.</p>
            : managers.data.map((m) => <ManagerRow key={`${m.id}:${m.company_ids.join()}:${m.is_active}`} manager={m} companies={companies} onChanged={managers.refetch} />)}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Shared ad accounts</CardTitle>
          <CardDescription>
            When one company&apos;s ad account runs campaigns for others, merge them here. Each merged company gets a fixed category;
            its admin and its ads managers then see only that category&apos;s campaigns. The owner company sees everything.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {companies.filter((c) => c.account).length === 0 ? (
            <p className="text-sm text-muted-foreground">No company has connected an ad account yet (Automation → Facebook Ads).</p>
          ) : companies.filter((c) => c.account).map((c) => (
            <MergeRow key={`${c.company_id}:${c.members.join()}`} owner={c} companies={companies} onChanged={overview.refetch} />
          ))}
          <ul className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
            {companies.map((c) => (
              <li key={c.company_id}>
                {c.company_name}: {c.account ? "own ad account" : c.member_of ? `shares ${name(c.member_of)}'s account` : "no ad account"}
                {c.won_to_ads_client ? " · won leads become ads clients" : ""}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <NewManagerDialog open={adding} onOpenChange={setAdding} companies={companies} onCreated={managers.refetch} />
    </div>
  );
}

function CompanyChecks({ companies, value, onChange, idPrefix }: { companies: CompanyAds[]; value: string[]; onChange: (v: string[]) => void; idPrefix: string }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {companies.map((c) => (
        <Label key={c.company_id} htmlFor={`${idPrefix}-${c.company_id}`} className="flex items-center gap-2 font-normal">
          <Checkbox id={`${idPrefix}-${c.company_id}`} checked={value.includes(c.company_id)}
            onCheckedChange={(v) => onChange(v === true ? [...value, c.company_id] : value.filter((x) => x !== c.company_id))} />
          {c.company_name}
        </Label>
      ))}
    </div>
  );
}

function ManagerRow({ manager, companies, onChanged }: { manager: AdsManager; companies: CompanyAds[]; onChanged: () => void }) {
  const [picked, setPicked] = useState(manager.company_ids);
  const [pending, start] = useTransition();
  const [resetting, setResetting] = useState(false);
  const dirty = [...picked].sort().join() !== [...manager.company_ids].sort().join();
  const save = () => start(async () => {
    const r = await setAdsManagerCompanies({ id: manager.id, companyIds: picked });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Companies saved. Access changes at once.");
    onChanged();
  });
  const toggle = () => start(async () => {
    const r = await updateAdsManager({ id: manager.id, isActive: !manager.is_active });
    if (!r.ok) { toast.error(r.error); return; }
    onChanged();
  });
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{manager.display_name}</div>
          <div className="text-xs text-muted-foreground">{manager.username} · since {formatDate(manager.created_at)}</div>
        </div>
        <Badge variant="outline" className={manager.is_active ? "border-emerald-400/30 text-emerald-300" : "text-muted-foreground"}>{manager.is_active ? "Active" : "Off"}</Badge>
        <Button variant="ghost" size="icon-sm" aria-label="Reset password" onClick={() => setResetting(true)}><KeyRound /></Button>
        {manager.is_active ? (
          <ConfirmDialog trigger={<Button variant="ghost" size="icon-sm" aria-label="Turn off"><UserX /></Button>}
            title={`Turn off ${manager.display_name}?`} description="They can no longer sign in. Their companies stay ticked." confirmLabel="Turn off" destructive
            onConfirm={async () => { toggle(); }} />
        ) : <Button variant="ghost" size="icon-sm" aria-label="Turn on" onClick={toggle} disabled={pending}><UserCheck /></Button>}
      </div>
      <CompanyChecks companies={companies} value={picked} onChange={setPicked} idPrefix={`m-${manager.id}`} />
      {dirty ? <Button size="sm" onClick={save} disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : <Save />} Save companies</Button> : null}
      <PasswordDialog open={resetting} onOpenChange={setResetting} title={`New password for ${manager.username}`}
        onSave={(password) => resetAdsManagerPassword({ id: manager.id, password })} />
    </div>
  );
}

function MergeRow({ owner, companies, onChanged }: { owner: CompanyAds; companies: CompanyAds[]; onChanged: () => void }) {
  const [picked, setPicked] = useState(owner.members);
  const [pending, start] = useTransition();
  const others = companies.filter((c) => c.company_id !== owner.company_id && !c.account && (!c.member_of || c.member_of === owner.company_id));
  const dirty = [...picked].sort().join() !== [...owner.members].sort().join();
  const save = () => start(async () => {
    const r = await mergeAdAccount({ accountId: owner.account!.id, companyIds: picked });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(picked.length ? "Merged. Each company now has its own category." : "Unmerged");
    onChanged();
  });
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{owner.company_name}</div>
          <div className="text-xs text-muted-foreground">{owner.account?.name ?? `act_${owner.account?.act_id}`}{owner.account?.currency ? ` · ${owner.account.currency}` : ""}</div>
        </div>
        <AdAccountStatus account={owner.account} />
      </div>
      {others.length === 0 ? <p className="text-xs text-muted-foreground">Every other company has its own ad account.</p> : (
        <>
          <p className="text-xs text-muted-foreground">Also runs campaigns for:</p>
          <CompanyChecks companies={others} value={picked} onChange={setPicked} idPrefix={`g-${owner.company_id}`} />
        </>
      )}
      {dirty ? <Button size="sm" onClick={save} disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : <Save />} Save sharing</Button> : null}
    </div>
  );
}

function NewManagerDialog({ open, onOpenChange, companies, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; companies: CompanyAds[]; onCreated: () => void }) {
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });
  const [picked, setPicked] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await createAdsManager({ ...form, companyIds: picked });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Ads manager created");
      setForm({ username: "", displayName: "", password: "" });
      setPicked([]);
      onOpenChange(false);
      onCreated();
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Add ads manager</DialogTitle>
            <DialogDescription>They sign in with this username and password and see only the ads of the companies you tick.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field><FieldLabel htmlFor="am-user">Username</FieldLabel><Input id="am-user" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" required /></Field>
            <Field><FieldLabel htmlFor="am-name">Name</FieldLabel><Input id="am-name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required maxLength={80} /></Field>
            <Field>
              <FieldLabel htmlFor="am-pass">Password</FieldLabel>
              <Input id="am-pass" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" required minLength={8} maxLength={72} />
              <FieldDescription>At least 8 characters.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Companies</FieldLabel>
              <CompanyChecks companies={companies} value={picked} onChange={setPicked} idPrefix="new-am" />
            </Field>
          </FieldGroup>
          <DialogFooter><Button type="submit" disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : <Plus />} Create</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PasswordDialog({ open, onOpenChange, title, onSave }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; onSave: (password: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [password, setPassword] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setPassword(""); }}>
      <DialogContent className="sm:max-w-sm">
        <form className="grid gap-4" onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await onSave(password);
            if (!r.ok) { toast.error(r.error ?? "Could not save"); return; }
            toast.success("Password changed");
            setPassword("");
            onOpenChange(false);
          });
        }}>
          <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Share it with them privately.</DialogDescription></DialogHeader>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} maxLength={72} required aria-label="New password" />
          <DialogFooter><Button type="submit" disabled={pending || password.length < 8}>{pending ? <Loader2 className="animate-spin" /> : null} Save password</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
