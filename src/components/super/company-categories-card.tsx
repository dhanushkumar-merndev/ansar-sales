"use client";

import { useState, useTransition } from "react";
import { Loader2, Save, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useShowMore } from "@/hooks/use-show-more";
import { type AdAccount, matchCategories } from "@/lib/ads";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { setCompanyAdCategories } from "@/server/actions/ads";

export type AccountCategory = {
  id: string; name: string; company_id: string | null; company_name: string | null;
  ads_client_id: string | null; client_name: string | null; campaigns: number;
};
/** One company of ours in `super_ads_overview`. */
export type CompanyAds = {
  company_id: string; company_name: string; won_to_ads_client: boolean; account: AdAccount | null; members: string[]; member_of: string | null;
  /** Categories of the company's own live ad account. */
  account_categories: AccountCategory[];
};

/**
 * Super admin: which categories of a shared ad account are this company's. New Facebook leads from
 * their campaigns go to its CRM, and it sees those campaigns on its Ads page. For the account's
 * owner it lists what was given to whom. `embedded`: inside another card, without its own.
 */
export function CompanyCategoriesCard({ companyId, companies, onChanged, embedded }: {
  companyId: string; companies: CompanyAds[]; onChanged: () => void; embedded?: boolean;
}) {
  const me = companies.find((c) => c.company_id === companyId);
  // A company's categories live on an account of another company of ours.
  const owners = companies.filter((c) => c.account && c.company_id !== companyId && (!me?.member_of || c.company_id === me.member_of));
  const [picked, setPicked] = useState<string | null>(null);
  const owner = owners.find((c) => c.company_id === picked) ?? owners[0];
  if (!me) return null;

  const body = me.account ? <OwnerSummary me={me} />
    : !owner ? <p className="text-sm text-muted-foreground">Connect one of our companies&apos; ad accounts first (Facebook leads → Ad account ID).</p>
    : (
      <>
        {owners.length > 1 ? (
          <Select value={owner.company_id} onValueChange={setPicked}>
            <SelectTrigger size="sm" className="w-64" aria-label="Ad account"><SelectValue /></SelectTrigger>
            <SelectContent>
              {owners.map((c) => <SelectItem key={c.company_id} value={c.company_id}>{c.account?.name ?? c.company_name} · {c.company_name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
        <CategoryChecklist key={`${owner.company_id}:${idsOf(owner, companyId).join(",")}`}
          me={me} owner={owner} onChanged={onChanged} />
      </>
    );

  if (embedded) return <div className="space-y-3">{body}</div>;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Leads from ad categories</CardTitle>
        <CardDescription>
          {me.account
            ? `Campaigns on ${me.account.name ?? "this company's ad account"} and their Facebook leads, by company.`
            : `New Facebook leads from campaigns in these categories go to ${me.company_name}'s CRM, and ${me.company_name} sees those campaigns on its Ads page.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">{body}</CardContent>
    </Card>
  );
}

const idsOf = (owner: CompanyAds, companyId: string) =>
  owner.account_categories.filter((k) => k.company_id === companyId).map((k) => k.id).sort();

function CategoryChecklist({ me, owner, onChanged }: { me: CompanyAds; owner: CompanyAds; onChanged: () => void }) {
  const saved = idsOf(owner, me.company_id);
  const [ticked, setTicked] = useState<string[]>(saved);
  const [search, setSearch] = useState("");
  const [pending, start] = useTransition();
  // Clients' categories bring their leads to the client's CRM, so they aren't offered.
  const list = matchCategories(owner.account_categories.filter((k) => !k.ads_client_id), search);
  const paging = useShowMore(list.length, search);
  const dirty = [...ticked].sort().join() !== saved.join();
  const toggle = (id: string, on: boolean) => setTicked((t) => (on ? [...new Set([...t, id])] : t.filter((x) => x !== id)));

  const save = () => start(async () => {
    const r = await setCompanyAdCategories({ accountId: owner.account!.id, companyId: me.company_id, categoryIds: ticked });
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(ticked.length
      ? `New Facebook leads from these categories go to ${me.company_name}.`
      : `${me.company_name} has no categories now; their leads stay with ${owner.company_name}.`);
    onChanged();
  });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        On {owner.account?.name ?? "the ad account"} of {owner.company_name}. {formatCount(ticked.length)} ticked.
      </p>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search categories" maxLength={60}
          className="h-8 pl-8" aria-label="Search categories" />
      </div>
      <div className="max-h-72 divide-y overflow-y-auto rounded-lg border" onScroll={paging.onScroll}>
        {list.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {search ? "No category matches." : "This ad account has no categories yet. Add them on the Ads page (Categories)."}
          </p>
        ) : list.slice(0, paging.count).map((k) => {
          const taken = Boolean(k.company_id && k.company_id !== me.company_id);
          return (
            <Label key={k.id} className={cn("flex items-center gap-3 px-3 py-2 font-normal", taken ? "opacity-60" : "cursor-pointer")}>
              <Checkbox checked={ticked.includes(k.id)} disabled={taken || pending} onCheckedChange={(v) => toggle(k.id, v === true)} />
              <span className="min-w-0 flex-1 truncate">{k.name}</span>
              {taken ? <span className="shrink-0 text-xs text-muted-foreground">→ {k.company_name}</span> : null}
              <span className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                {formatCount(k.campaigns)} campaign{k.campaigns === 1 ? "" : "s"}
              </span>
            </Label>
          );
        })}
        {paging.more ? <p className="px-3 py-1.5 text-xs text-muted-foreground">Scroll for {formatCount(paging.more)} more</p> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Leads that already came in stay where they are. Put campaigns into categories on the Ads page.
      </p>
      {dirty ? (
        <Button size="sm" onClick={save} disabled={pending}>{pending ? <Loader2 className="animate-spin" /> : <Save />} Save categories</Button>
      ) : null}
    </div>
  );
}

/** The account's owner: what it gave to each company; everything else brings its leads here. */
function OwnerSummary({ me }: { me: CompanyAds }) {
  const given = new Map<string, string[]>();
  for (const k of me.account_categories) {
    if (k.company_id && k.company_name) given.set(k.company_name, [...(given.get(k.company_name) ?? []), k.name]);
  }
  return (
    <div className="space-y-2 text-sm">
      {given.size ? (
        <ul className="divide-y rounded-lg border">
          {[...given].sort(([a], [b]) => a.localeCompare(b)).map(([company, names]) => (
            <li key={company} className="flex flex-wrap gap-x-2 px-3 py-2">
              <span className="font-medium">{company}</span>
              <span className="text-muted-foreground">{names.join(", ")}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-muted-foreground">No category is given to another company yet.</p>}
      <p className="text-xs text-muted-foreground">
        Campaigns in every other category (and uncategorised ones) bring their leads to {me.company_name}; an ads client&apos;s category brings
        them to the client&apos;s CRM. Pick another company above to give it categories.
      </p>
    </div>
  );
}
