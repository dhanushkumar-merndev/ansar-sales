"use client";

import { useState, useTransition } from "react";
import { Building2, Check, Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { BrandMark, BrandName } from "@/components/app/brand";
import { CompanyDialog, type EditableCompany } from "@/components/app/company-dialog";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { UsageView } from "@/components/settings/usage-view";
import { AdsTab } from "@/components/super/ads-tab";
import { FinanceMergeTab } from "@/components/super/finance-merge-tab";
import { MetaLeadsTab } from "@/components/automation/facebook-leads";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { companyLogoUrl } from "@/lib/companies";
import { formatCount } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/time";
import { switchCompany, type CompanySummary } from "@/server/actions/companies";

const TABS = { companies: "Companies", books: "Finance merge", facebook: "Facebook leads", ads: "Ads", usage: "Usage" } as const;
type Tab = keyof typeof TABS;

const DESCRIPTIONS: Record<Tab, string> = {
  companies: "Every company has its own leads, users, library and finance. Switch from the top-left menu.",
  books: "Let several companies share one finance account, and choose which of them may edit it.",
  facebook: "Each company's Facebook Lead Ads connection, and who receives its new leads.",
  ads: "Ads managers and the companies they handle, and ad accounts shared between companies.",
  usage: "How much of the Supabase plan all companies use together, and what you can clean up.",
};

export function SuperSettingsView() {
  const { params, set } = useUrlState();
  const raw = params.get("tab");
  const tab: Tab = raw && raw in TABS ? (raw as Tab) : "companies";
  return (
    <div className="w-full space-y-6">
      <PageHeader title="Super settings" description={DESCRIPTIONS[tab]} />
      <Tabs value={tab} onValueChange={(v) => set({ tab: v === "companies" ? null : v })}>
        <TabsList>
          {(Object.keys(TABS) as Tab[]).map((t) => <TabsTrigger key={t} value={t}>{TABS[t]}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      {tab === "usage" ? <UsageView /> : tab === "books" ? <FinanceMergeTab /> : tab === "facebook" ? <MetaLeadsTab /> : tab === "ads" ? <AdsTab /> : <CompaniesTab />}
    </div>
  );
}

async function fetchCompanies(signal: AbortSignal) {
  const { data, error } = await createClient().rpc("super_list_companies").abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as CompanySummary[];
}

function CompaniesTab() {
  const me = useProfile();
  const companies = useLiveQuery({ queryKey: "super-companies", fetcher: fetchCompanies, tables: ["companies", "profiles"] });
  const [editing, setEditing] = useState<EditableCompany | null>(null);
  const [adding, setAdding] = useState(false);
  const [switching, startSwitch] = useTransition();
  const [target, setTarget] = useState<string | null>(null);

  const open = (id: string) => {
    setTarget(id);
    startSwitch(async () => {
      const res = await switchCompany({ id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // A full load: every list, cache and Realtime channel then belongs to the new company.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/dashboard");
    });
  };

  if (companies.error && !companies.data) return <ErrorState message={companies.error} onRetry={companies.refetch} />;

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium"><Building2 className="size-4" /> Companies</div>
        <div className="flex items-center gap-2">
          <FetchingIndicator show={companies.isFetching && !companies.isInitialLoading} />
          <Button size="sm" onClick={() => setAdding(true)}><Plus /> Add company</Button>
        </div>
      </div>
      {companies.isInitialLoading ? <div className="p-4"><ListSkeleton rows={3} /></div> : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead className="text-right">Active users</TableHead>
              <TableHead className="text-right">Admins</TableHead>
              <TableHead className="text-right">Leads</TableHead>
              <TableHead className="hidden md:table-cell">Created</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(companies.data ?? []).map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <BrandMark size={28} logoUrl={companyLogoUrl(c.logo_path)} />
                    <BrandName name={c.name} highlight={c.brand_highlight} className="font-medium" />
                    {c.id === me.company.id ? <Badge variant="outline" className="gap-1"><Check className="size-3" /> Current</Badge> : null}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(c.users)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {c.admins === 0 ? <span className="text-amber-400">None yet</span> : formatCount(c.admins)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(c.leads)}</TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">{formatDate(c.created_at)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}><Pencil /></Button>
                    {c.id !== me.company.id ? (
                      <Button variant="outline" size="sm" disabled={switching} onClick={() => open(c.id)}>
                        {switching && target === c.id ? <Loader2 className="animate-spin" /> : null} Open
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="border-t px-4 py-3 text-xs text-muted-foreground">
        To add a company&apos;s admin and staff, open the company and use Users. You stay admin of every company.
      </p>
      <CompanyDialog open={adding} onOpenChange={setAdding} onSaved={open} />
      <CompanyDialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }} company={editing}
        onSaved={(id) => { void companies.refetch(); if (id === me.company.id) window.location.reload(); }} />
    </Card>
  );
}
