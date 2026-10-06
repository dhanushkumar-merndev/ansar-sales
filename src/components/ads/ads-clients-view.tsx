"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { AdAccountStatus } from "@/components/ads/ad-account-form";
import { AdsTabs } from "@/components/ads/ads-view";
import { DataPagination } from "@/components/common/data-pagination";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { type AdAccount, adKpis, type AdsClient, ADS_CLIENT_STATUS_LABELS, type AdsClientStatus, moneyFormat } from "@/lib/ads";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { formatCount } from "@/lib/format";
import { cleanSearch } from "@/lib/search";
import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { createAdsClient } from "@/server/actions/ads";

type ClientRow = AdsClient & {
  account: AdAccount | null;
  last_30d: { spend: number; leads: number; clicks: number; impressions: number };
  logins: number;
};

export function clientStatusTone(status: AdsClientStatus) {
  return status === "active" ? "border-emerald-400/30 text-emerald-300"
    : status === "onboarding" ? "border-sky-400/30 text-sky-300"
    : status === "paused" ? "border-amber-400/30 text-amber-300" : "text-muted-foreground";
}

/** Won leads handed to the ads team, plus clients added by hand. */
export function AdsClientsView() {
  const profile = useProfile();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [input, setInput] = useState("");
  const search = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  const [status, setStatus] = useState<string>("open");
  const [adding, setAdding] = useState(false);
  const filterKey = `${search}:${status}`;
  const [lastKey, setLastKey] = useState(filterKey);
  if (lastKey !== filterKey) { setLastKey(filterKey); setPage(1); }

  const list = useLiveQuery({
    queryKey: `ads-clients:${profile.company.id}:${filterKey}:${page}:${pageSize}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("list_ads_clients", {
        p_search: search || undefined, p_status: status === "all" ? undefined : status, p_limit: pageSize, p_offset: (page - 1) * pageSize,
      }).abortSignal(signal);
      if (error) throw error;
      return data as unknown as { items: ClientRow[]; total: number };
    },
  });

  return (
    <>
      <PageHeader
        title="Ads"
        description={`Clients ${profile.company.name} runs ads for. Won leads arrive here automatically.`}
        actions={<><FetchingIndicator show={list.isFetching && !list.isInitialLoading} /><Button onClick={() => setAdding(true)}><Plus /> Add client</Button></>}
      />
      <AdsTabs />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search name, business, phone" className="w-64 pl-8" aria-label="Search clients" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40" aria-label="Status"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Current clients</SelectItem>
            <SelectItem value="all">All, including closed</SelectItem>
            {Object.entries(ADS_CLIENT_STATUS_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {list.error && !list.data ? <ErrorState message={list.error} onRetry={list.refetch} />
        : !list.data ? <ListSkeleton rows={6} />
        : list.data.items.length === 0 ? <EmptyState title="No clients yet" description="When a lead is marked Won it appears here. You can also add a client yourself." />
        : (
          <Card className="gap-0 overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-56">Client</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Ad account</TableHead>
                  <TableHead className="text-right">Spent (30 days)</TableHead>
                  <TableHead className="text-right">Results</TableHead>
                  <TableHead className="text-right">Cost / result</TableHead>
                  <TableHead>Since</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.items.map((c) => {
                  const money = moneyFormat(c.account?.currency);
                  const k = adKpis({ ...c.last_30d, conversions: 0, conversion_value: 0 });
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Link href={`/ads/clients/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                        <div className="text-xs text-muted-foreground">{[c.business, c.phone].filter(Boolean).join(" · ") || "—"}</div>
                      </TableCell>
                      <TableCell><Badge variant="outline" className={cn(clientStatusTone(c.status))}>{ADS_CLIENT_STATUS_LABELS[c.status]}</Badge></TableCell>
                      <TableCell><AdAccountStatus account={c.account} /></TableCell>
                      <TableCell className="text-right tabular-nums">{c.account ? money(c.last_30d.spend) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.account ? formatCount(Number(c.last_30d.leads)) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{k.cpl != null ? money(k.cpl) : "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatDate(c.started_at)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        )}
      {list.data ? (
        <DataPagination page={page} pageSize={pageSize} total={list.data.total} disabled={list.isFetching}
          onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
      ) : null}
      <NewClientDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

function NewClientDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", business: "", phone: "", email: "", notes: "" });
  const [pending, start] = useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await createAdsClient(form);
      if (!r.ok) { toast.error(r.error); return; }
      onOpenChange(false);
      router.push(`/ads/clients/${r.data.id}`);
    });
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Add ads client</DialogTitle>
            <DialogDescription>For a client who didn&apos;t come through the Leads pipeline.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field><FieldLabel htmlFor="ac-name">Name</FieldLabel><Input id="ac-name" value={form.name} onChange={set("name")} required maxLength={120} /></Field>
            <Field><FieldLabel htmlFor="ac-business">Business</FieldLabel><Input id="ac-business" value={form.business} onChange={set("business")} maxLength={120} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="ac-phone">Phone</FieldLabel><Input id="ac-phone" value={form.phone} onChange={set("phone")} maxLength={32} /></Field>
              <Field><FieldLabel htmlFor="ac-email">Email</FieldLabel><Input id="ac-email" type="email" value={form.email} onChange={set("email")} maxLength={254} /></Field>
            </div>
            <Field><FieldLabel htmlFor="ac-notes">Notes</FieldLabel><Textarea id="ac-notes" value={form.notes} onChange={set("notes")} maxLength={2000} rows={3} /></Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending || !form.name.trim()}>{pending ? <Loader2 className="animate-spin" /> : null} Add client</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
