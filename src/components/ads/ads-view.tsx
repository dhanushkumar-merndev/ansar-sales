"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, Plug, Plus, Tags, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AdAccountForm } from "@/components/ads/ad-account-form";
import { AdsDashboard } from "@/components/ads/ads-dashboard";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveQuery } from "@/hooks/use-live-query";
import type { AdAccount, AdCategory } from "@/lib/ads";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { archiveAdCategory, saveAdCategory } from "@/server/actions/ads";

/** Dashboard / Clients switch shown on every ads page. */
export function AdsTabs() {
  const pathname = usePathname();
  const tabs = [{ href: "/ads", label: "Ad account" }, { href: "/ads/clients", label: "Clients" }];
  return (
    <nav className="mb-5 inline-flex rounded-lg border p-0.5 text-sm" aria-label="Ads sections">
      {tabs.map((t) => {
        const active = t.href === "/ads" ? pathname === "/ads" : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined}
            className={cn("rounded-md px-3 py-1.5", active ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

async function fetchAccounts(signal: AbortSignal) {
  const { data, error } = await createClient().rpc("ads_accounts_for_me").abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as unknown as AdAccount[];
}

/** The current company's ad account (or the merged account it shares), for admins and ads managers. */
export function AdsView() {
  const profile = useProfile();
  const accounts = useLiveQuery({ queryKey: `ads-accounts:${profile.company.id}`, fetcher: fetchAccounts, pollMs: 5 * 60_000 });
  const [picked, setPicked] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [editingCategories, setEditingCategories] = useState(false);
  const list = accounts.data ?? [];
  const current = list.find((a) => a.id === picked) ?? list[0];
  const own = list.find((a) => a.company_id === profile.company.id && !a.archived_at) ?? null;

  return (
    <>
      <PageHeader
        title="Ads"
        description={`Facebook and Instagram ad results for ${profile.company.name}, synced from Meta every hour.`}
        actions={current?.scope === "all" && !current.archived_at ? (
          <>
            <Button variant="outline" onClick={() => setEditingCategories(true)}><Tags /> Categories</Button>
            {current.company_id === profile.company.id ? <Button variant="outline" onClick={() => setConnecting(true)}><Plug /> Connection</Button> : null}
          </>
        ) : null}
      />
      <AdsTabs />
      {accounts.error && !accounts.data ? <ErrorState message={accounts.error} onRetry={accounts.refetch} />
        : !accounts.data ? <ListSkeleton rows={6} />
        : !current ? (
          <EmptyState
            title="No ad account connected"
            description="Connect this company's Meta ad account to see spend, results and every campaign here."
            action={<Button onClick={() => setConnecting(true)}><Plug /> Connect ad account</Button>}
          />
        ) : (
          <div className="space-y-4">
            {list.length > 1 ? (
              <Select value={current.id} onValueChange={setPicked}>
                <SelectTrigger className="w-80" aria-label="Ad account"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {list.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name ?? `act_${a.act_id}`}{a.company_id !== profile.company.id ? ` · shared by ${a.company_name}` : ""}{a.archived_at ? " · disconnected" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {current.scope === "company" ? (
              <p className="text-sm text-muted-foreground">
                This ad account belongs to <span className="text-foreground">{current.company_name}</span>. You see only the campaigns in {profile.company.name}&apos;s category.
              </p>
            ) : null}
            <AdsDashboard key={current.id} accountId={current.id} canManage={current.scope === "all"} />
          </div>
        )}
      <Dialog open={connecting} onOpenChange={setConnecting}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Meta ad account</DialogTitle>
            <DialogDescription>For {profile.company.name}. One ad account per company; the super admin can share it with other companies.</DialogDescription>
          </DialogHeader>
          <AdAccountForm kind="company" ownerId={profile.company.id} account={own} onChanged={accounts.refetch} />
        </DialogContent>
      </Dialog>
      {current ? <CategoriesDialog open={editingCategories} onOpenChange={setEditingCategories} accountId={current.id} /> : null}
    </>
  );
}

function CategoriesDialog({ open, onOpenChange, accountId }: { open: boolean; onOpenChange: (o: boolean) => void; accountId: string }) {
  const cats = useLiveQuery({
    queryKey: `ads-categories:${accountId}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("ad_categories_list", { p_account: accountId }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as AdCategory[];
    },
    enabled: open,
    pollMs: 0,
  });
  const [name, setName] = useState("");
  const [match, setMatch] = useState("");
  const [pending, start] = useTransition();
  const add = () => start(async () => {
    const r = await saveAdCategory({ accountId, name, matchText: match });
    if (!r.ok) { toast.error(r.error); return; }
    setName(""); setMatch("");
    cats.refetch();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85svh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Campaign categories</DialogTitle>
          <DialogDescription>
            Split one ad account&apos;s campaigns, for example by company. A campaign whose name contains the &quot;match&quot; text is filed automatically;
            you can also pick a category per campaign in the table. Companies sharing this account have fixed categories.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!cats.data ? <ListSkeleton rows={3} /> : cats.data.length === 0 ? <p className="text-sm text-muted-foreground">No categories yet.</p> : (
            <ul className="divide-y rounded-lg border">
              {cats.data.map((c) => <CategoryRow key={`${c.id}:${c.match_text}`} accountId={accountId} category={c} onChanged={cats.refetch} />)}
            </ul>
          )}
        </div>
        <div className="grid gap-2 border-t pt-3 sm:grid-cols-[1fr_1fr_auto]">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New category, e.g. Star Tech India" aria-label="Category name" />
          <Input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="Match text (optional), e.g. STI" aria-label="Match text" />
          <Button onClick={add} disabled={pending || !name.trim()}>{pending ? <Loader2 className="animate-spin" /> : <Plus />} Add</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CategoryRow({ accountId, category, onChanged }: { accountId: string; category: AdCategory; onChanged: () => void }) {
  const [match, setMatch] = useState(category.match_text ?? "");
  const [pending, start] = useTransition();
  const saveMatch = () => {
    if ((category.match_text ?? "") === match.trim()) return;
    start(async () => {
      const r = await saveAdCategory({ accountId, id: category.id, name: category.name, matchText: match });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Saved; matching campaigns were filed");
      onChanged();
    });
  };
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 font-medium">{category.name}</span>
      {category.company_id ? <Badge variant="outline" className="text-muted-foreground">Company</Badge> : null}
      <span className="text-xs text-muted-foreground">{category.campaigns} campaigns</span>
      <Input value={match} onChange={(e) => setMatch(e.target.value)} onBlur={saveMatch} disabled={pending}
        placeholder="Match text" className="h-8 w-36" aria-label={`Match text for ${category.name}`} />
      {!category.company_id ? (
        <ConfirmDialog
          trigger={<Button variant="ghost" size="icon-sm" aria-label={`Remove ${category.name}`}><Trash2 /></Button>}
          title={`Remove "${category.name}"?`}
          description="Its campaigns become uncategorised. Spend history is not affected."
          confirmLabel="Remove" destructive
          onConfirm={async () => {
            const r = await archiveAdCategory({ id: category.id });
            if (!r.ok) { toast.error(r.error); return false; }
            onChanged();
          }}
        />
      ) : null}
    </li>
  );
}
