"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, ListPlus, Loader2, Plug, Plus, Search, Tags, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AdAccountForm } from "@/components/ads/ad-account-form";
import { AdsDashboard } from "@/components/ads/ads-dashboard";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { PageHeader } from "@/components/common/page-header";
import type { DayRange } from "@/components/common/range-picker";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { sliceGroups, useShowMore } from "@/hooks/use-show-more";
import { type AdAccount, type AdCampaignRow, type AdCategory, matchCategories } from "@/lib/ads";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { formatCount } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { hasAnyRole } from "@/lib/permissions";
import { cleanSearch } from "@/lib/search";
import { addDays, istToday } from "@/lib/time";
import { cn } from "@/lib/utils";
import { archiveAdCategory, deleteAdAccountHistory, saveAdCategory, setAdCategoryDashboard, setCampaignCategory } from "@/server/actions/ads";

/** Dashboard / Our company / Clients switch shown on every ads page. */
export function AdsTabs() {
  const pathname = usePathname();
  const tabs = [{ href: "/ads", label: "Ad account" }, { href: "/ads/companies", label: "Our company" }, { href: "/ads/clients", label: "Clients" }];
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

/** Where the dashboard opens: an account, one category ("none" = uncategorised) and days, from the Our company tab. */
export type AdsViewStart = { account?: string; category?: string; range?: DayRange };

/** The current company's ad account (or the merged account it shares), for admins and ads managers. */
export function AdsView({ start = {} }: { start?: AdsViewStart }) {
  const profile = useProfile();
  const accounts = useLiveQuery({ queryKey: `ads-accounts:${profile.company.id}`, fetcher: fetchAccounts, pollMs: 5 * 60_000 });
  const [picked, setPicked] = useState<string | null>(start.account ?? null);
  const [connecting, setConnecting] = useState(false);
  const [editingCategories, setEditingCategories] = useState(false);
  const [categoryVersion, setCategoryVersion] = useState(0);
  const list = accounts.data ?? [];
  const current = list.find((a) => a.id === picked) ?? list[0];
  const own = list.find((a) => a.company_id === profile.company.id && !a.archived_at) ?? null;

  const picker = current && list.length > 1 ? (
    <Select value={current.id} onValueChange={setPicked}>
      <SelectTrigger className="w-64" aria-label="Ad account"><SelectValue /></SelectTrigger>
      <SelectContent>
        {list.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name ?? `act_${a.act_id}`}{a.company_id !== profile.company.id ? ` · shared by ${a.company_name}` : ""}{a.archived_at ? " · disconnected" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ) : null;

  return (
    <>
      <PageHeader
        title="Ads"
        description={`Facebook and Instagram ad results for ${profile.company.name}, synced from Meta every hour.`}
        actions={(
          <>
            {picker}
            {current?.scope === "all" && !current.archived_at ? (
              <>
                <Button variant="outline" onClick={() => setEditingCategories(true)}><Tags /> Categories</Button>
                {current.company_id === profile.company.id ? <Button variant="outline" onClick={() => setConnecting(true)}><Plug /> Connection</Button> : null}
              </>
            ) : current?.scope === "all" && current.archived_at && hasAnyRole(profile.roles, ["admin"]) ? (
              <ConfirmDialog
                trigger={<Button variant="outline"><Trash2 /> Delete history</Button>}
                title="Delete this ad history?"
                description={`Everything synced from ${current.name ?? `act_${current.act_id}`} (campaigns, ads, daily results and categories) is deleted for good. This can't be undone.`}
                confirmLabel="Delete history"
                destructive
                onConfirm={async () => {
                  const r = await deleteAdAccountHistory({ accountId: current.id });
                  if (!r.ok) { toast.error(r.error); return false; }
                  toast.success("Ad history deleted");
                  setPicked(null);
                  accounts.refetch();
                }}
              />
            ) : null}
          </>
        )}
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
            {current.scope === "company" ? (
              <p className="text-sm text-muted-foreground">
                This ad account belongs to <span className="text-foreground">{current.company_name}</span>. You see only the campaigns in {profile.company.name}&apos;s category.
              </p>
            ) : null}
            <AdsDashboard key={current.id} accountId={current.id} canManage={current.scope === "all"} version={categoryVersion}
              initial={current.id === start.account ? { category: start.category, range: start.range } : undefined} />
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
      {current ? <CategoriesDialog open={editingCategories} onOpenChange={setEditingCategories} accountId={current.id} onChanged={() => setCategoryVersion((v) => v + 1)} /> : null}
    </>
  );
}

function CategoriesDialog({ open, onOpenChange, accountId, onChanged }: {
  open: boolean; onOpenChange: (o: boolean) => void; accountId: string; onChanged: () => void;
}) {
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
  const [search, setSearch] = useState("");
  const groups = [
    { title: "Our company", hint: "Counted in the Ads dashboard. Uncategorised campaigns count here too.", list: (cats.data ?? []).filter((c) => c.in_dashboard) },
    { title: "Clients", hint: "Kept out of the dashboard totals. Pick them in the dashboard's category filter to see them.", list: (cats.data ?? []).filter((c) => !c.in_dashboard) },
  ].map((g) => ({ ...g, matches: matchCategories(g.list, search) }));
  // 20 rows at first, 20 more each time the list is scrolled near its end.
  const paging = useShowMore(groups[0].matches.length + groups[1].matches.length, search);
  const shown = sliceGroups(groups.map((g) => g.matches), paging.count);
  const newNameRef = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const add = () => start(async () => {
    const r = await saveAdCategory({ accountId, name, matchText: match });
    if (!r.ok) { toast.error(r.error); return; }
    setName(""); setMatch("");
    cats.refetch();
    onChanged();
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85svh] flex-col sm:max-w-4xl" onOpenAutoFocus={(e) => { e.preventDefault(); newNameRef.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle>Campaign categories</DialogTitle>
          <DialogDescription>
            Split one ad account&apos;s campaigns, for example by company. A campaign whose name contains the &quot;match&quot; text is filed automatically;
            use &quot;Add campaigns&quot; to pick several by hand. Companies sharing this account, and ads clients run from it, have fixed categories.
            Switch a category on to count it as our company in the Ads dashboard; switched off, it&apos;s a client&apos;s and stays out of the totals.
          </DialogDescription>
        </DialogHeader>
        {(cats.data?.length ?? 0) > 8 ? (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search categories or clients" className="pl-8" aria-label="Search categories" />
          </div>
        ) : null}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto" onScroll={paging.onScroll}>
          {!cats.data ? <ListSkeleton rows={3} /> : cats.data.length === 0 ? <p className="text-sm text-muted-foreground">No categories yet.</p> : (
            groups.map((group, i) => (
              <section key={group.title} className="space-y-2">
                <div>
                  <h3 className="text-sm font-semibold">
                    {group.title} <span className="font-normal text-muted-foreground">· {search.trim() ? `${formatCount(group.matches.length)} of ${formatCount(group.list.length)}` : formatCount(group.list.length)}</span>
                  </h3>
                  <p className="text-xs text-muted-foreground">{group.hint}</p>
                </div>
                {shown[i].length ? (
                  <ul className="divide-y rounded-lg border">
                    {shown[i].map((c) => <CategoryRow key={`${c.id}:${c.name}:${c.match_text}`} accountId={accountId} category={c} onChanged={() => { cats.refetch(); onChanged(); }} />)}
                  </ul>
                ) : group.matches.length ? null : <p className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">{search.trim() ? "No match" : "None"}</p>}
              </section>
            ))
          )}
          {paging.more ? <p className="text-center text-xs text-muted-foreground">Scroll for {formatCount(paging.more)} more</p> : null}
        </div>
        <div className="grid gap-2 border-t pt-3 sm:grid-cols-[2fr_1fr_auto]">
          <Input ref={newNameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="New category, e.g. Star Tech India" aria-label="Category name" />
          <Input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="Match text (optional), e.g. STI" aria-label="Match text" />
          <Button onClick={add} disabled={pending || !name.trim()}>{pending ? <Loader2 className="animate-spin" /> : <Plus />} Add</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CategoryRow({ accountId, category, onChanged }: { accountId: string; category: AdCategory; onChanged: () => void }) {
  const [name, setName] = useState(category.name);
  const [match, setMatch] = useState(category.match_text ?? "");
  const [pending, start] = useTransition();
  // A merged company's or an ads client's category keeps its name and can't be removed here.
  const fixed = Boolean(category.company_id || category.ads_client_id);
  // Saves the name and match text on blur.
  const save = () => {
    if (!name.trim()) { setName(category.name); return; }
    if (category.name === name.trim() && (category.match_text ?? "") === match.trim()) return;
    start(async () => {
      const r = await saveAdCategory({ accountId, id: category.id, name, matchText: match });
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Saved; matching campaigns were filed");
      onChanged();
    });
  };
  const toggle = (on: boolean) => start(async () => {
    const r = await setAdCategoryDashboard({ id: category.id, on });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(on ? `${category.name} counts as our company` : `${category.name} moved to clients`);
    onChanged();
  });
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm sm:flex-nowrap">
      <Switch checked={category.in_dashboard} onCheckedChange={toggle} disabled={pending} className="shrink-0"
        aria-label={`Count ${category.name} as our company`} title={category.in_dashboard ? "Our company: counted in the dashboard" : "Client: not counted in the dashboard"} />
      {fixed ? <span className="min-w-0 flex-1 truncate font-medium">{category.name}</span> : (
        <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} disabled={pending} maxLength={60}
          className="h-8 min-w-48 flex-1 font-medium" aria-label={`Name of ${category.name}`} />
      )}
      {category.company_id ? <Badge variant="outline" className="shrink-0 text-muted-foreground">Company</Badge> : null}
      {category.ads_client_id ? (
        <Badge variant="outline" className="max-w-40 shrink-0 truncate text-muted-foreground" title="Linked on the client's page">Client · {category.client_name}</Badge>
      ) : null}
      <span className="shrink-0 text-xs text-muted-foreground">{category.campaigns} campaigns</span>
      <Input value={match} onChange={(e) => setMatch(e.target.value)} onBlur={save} disabled={pending}
        placeholder="Match text" className="h-8 w-44 shrink-0" aria-label={`Match text for ${category.name}`} />
      <AddCampaigns accountId={accountId} category={category} onChanged={onChanged} />
      {!fixed ? (
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

const PICK_LIMIT = 100;

/** Files several campaigns into one category at once: search, tick, save (up to 100 per save). */
export function AddCampaigns({ accountId, category, onChanged }: { accountId: string; category: Pick<AdCategory, "id" | "name">; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const search = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  const [picked, setPicked] = useState<Map<string, string>>(() => new Map());
  const [pending, start] = useTransition();
  const list = useLiveQuery({
    queryKey: `ads-campaign-pick:${accountId}:${search}`,
    fetcher: async (signal) => {
      const today = istToday();
      const { data, error } = await createClient().rpc("list_ad_campaigns", {
        p_account: accountId, p_from: addDays(today, -29), p_to: today,
        p_search: search || undefined, p_sort: "name", p_dir: "asc", p_limit: 50, p_offset: 0,
      }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as { items: AdCampaignRow[]; total: number };
    },
    enabled: open,
    pollMs: 0,
  });

  const toggle = (c: AdCampaignRow) => setPicked((prev) => {
    const next = new Map(prev);
    if (next.has(c.id)) next.delete(c.id);
    else if (next.size >= PICK_LIMIT) toast.error(`Pick up to ${PICK_LIMIT} at a time.`);
    else next.set(c.id, c.name);
    return next;
  });
  const save = () => start(async () => {
    const r = await setCampaignCategory({ campaignIds: [...picked.keys()], categoryId: category.id });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(`${picked.size} campaign${picked.size === 1 ? "" : "s"} filed under ${category.name}`);
    setPicked(new Map());
    setInput("");
    setOpen(false);
    onChanged();
  });
  const items = list.data?.items ?? [];

  return (
    <Popover open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`Add campaigns to ${category.name}`}><ListPlus /> Add campaigns</Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search campaigns…" value={input} onValueChange={setInput} maxLength={100} />
          <CommandList className="max-h-72">
            {list.error && !list.data ? <div className="px-3 py-6 text-center text-sm text-destructive">{list.error}</div>
              : !list.data ? <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
              : items.length === 0 ? <CommandEmpty>No campaigns found.</CommandEmpty>
              : (
                <CommandGroup>
                  {items.map((c) => {
                    const here = c.category?.id === category.id;
                    const on = picked.has(c.id);
                    return (
                      <CommandItem key={c.id} value={c.id} disabled={here} onSelect={() => toggle(c)} className="items-start">
                        <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                          on || here ? "border-primary bg-primary text-primary-foreground" : "border-input")} aria-hidden>
                          {on || here ? <Check className="size-3" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{c.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {here ? "Already in this category" : c.category ? `Now in ${c.category.name}` : "Uncategorised"}
                          </span>
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            {list.data && list.data.total > items.length ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">Showing {items.length} of {list.data.total}. Search to find the rest.</p>
            ) : null}
          </CommandList>
        </Command>
        <div className="flex items-center gap-2 border-t p-2">
          <span className="mr-auto text-xs text-muted-foreground">{picked.size} selected</span>
          {picked.size ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => setPicked(new Map())}>Clear</Button> : null}
          <Button size="sm" disabled={pending || !picked.size} onClick={save}>
            {pending ? <Loader2 className="animate-spin" /> : null} Add {picked.size || ""}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
