"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Search, Wallet } from "lucide-react";
import { DataPagination } from "@/components/common/data-pagination";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { MilestoneBadge } from "@/components/projects/payments/milestone-badge";
import { PaymentDialog } from "@/components/projects/payments/payment-dialogs";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { PAYMENT_MODE_LABELS, SEARCH_DEBOUNCE_MS, type PaymentMode } from "@/lib/constants";
import { formatINR } from "@/lib/format";
import { lastPage, parsePaging } from "@/lib/pagination";
import { fetchPaymentDues, fetchPaymentStatus, fetchPaymentsOverview, fetchPaymentsReceived, type DueView } from "@/lib/project-queries";
import type { PaymentDue } from "@/lib/projects";
import { cleanSearch } from "@/lib/search";
import { addDays, formatCalendarDate, formatMonthLong, istToday } from "@/lib/time";
import { cn } from "@/lib/utils";

const TABS = { due: "Due now", overdue: "Overdue", upcoming: "Upcoming", paid: "Paid", received: "Received" } as const;
type Tab = keyof typeof TABS;
const TABLES = ["project_payment_milestones", "project_payments", "project_phases", "projects"];

export function PaymentsView() {
  const me = useProfile();
  const { params, set } = useUrlState();
  const raw = params.get("tab");
  const tab: Tab = raw && raw in TABS ? (raw as Tab) : "due";
  const overview = useLiveQuery({ queryKey: `payments-overview:${me.id}`, fetcher: fetchPaymentsOverview, tables: TABLES });
  const o = overview.data;

  return (
    <>
      <PageHeader title="Payments" description="What clients owe, what is late, and what came in. Amounts are exact to the paisa." />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Collected this month" value={o ? formatINR(o.collected_month) : "…"} tone="good" />
        <Stat label="Due now" value={o ? formatINR(o.due_amount) : "…"} hint={o ? `${o.due_count} part${o.due_count === 1 ? "" : "s"}` : undefined} tone={o?.due_count ? "warn" : undefined} />
        <Stat label="Overdue (over a week)" value={o ? formatINR(o.overdue_amount) : "…"} hint={o ? `${o.overdue_count} part${o.overdue_count === 1 ? "" : "s"}` : undefined} tone={o?.overdue_count ? "bad" : undefined} />
        <Stat label="Collected so far" value={o ? formatINR(o.collected_total) : "…"} hint={o?.contract_total ? `of ${formatINR(o.contract_total)} in open contracts` : undefined} />
      </div>
      <Tabs value={tab} onValueChange={(v) => set({ tab: v === "due" ? null : v, page: null })}>
        <TabsList className="mb-3">{(Object.keys(TABS) as Tab[]).map((t) => <TabsTrigger key={t} value={t}>{TABS[t]}</TabsTrigger>)}</TabsList>
      </Tabs>
      {tab === "received" ? <ReceivedList /> : <DuesList view={tab} />}
    </>
  );
}

function DuesList({ view }: { view: DueView }) {
  const me = useProfile();
  const { params, set } = useUrlState();
  const query = useMemo(() => ({ ...parsePaging(params), q: cleanSearch(params.get("q")), view }), [params, view]);
  const [input, setInput] = useState(query.q);
  const debounced = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debounced !== query.q) set({ q: debounced }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  const list = useLiveQuery({ queryKey: `payment-dues:${me.id}:${JSON.stringify(query)}`, fetcher: (s) => fetchPaymentDues(query, s), tables: TABLES });
  const { data, isStale } = list;
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
  }, [data, isStale, query.page, query.pageSize, set]);
  const [paying, setPaying] = useState<PaymentDue | null>(null);

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="pl-8" placeholder="Search project, client or code" value={input} maxLength={100} onChange={(e) => setInput(e.target.value)} aria-label="Search payments" />
        </div>
        <FetchingIndicator show={list.isFetching && !list.isInitialLoading} />
      </div>
      {list.error && !data ? <ErrorState message={list.error} onRetry={list.refetch} /> : list.isInitialLoading ? <ListSkeleton /> : !data?.total ? (
        <EmptyState title={view === "overdue" ? "Nothing overdue" : view === "due" ? "Nothing due right now" : "Nothing here"} />
      ) : (
        <div className={cn(isStale && "opacity-60")}>
          <Card className="py-0">
            <div className="overflow-x-auto">
              <Table className="min-w-[760px]">
                <TableHeader><TableRow>
                  <TableHead>Project</TableHead><TableHead>Part</TableHead><TableHead>Due</TableHead><TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Left</TableHead><TableHead className="w-0" />
                </TableRow></TableHeader>
                <TableBody>
                  {data.items.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <Link href={`/projects/${m.project.id}?tab=payments`} className="font-medium hover:underline">{m.project.name}</Link>
                        <div className="text-xs text-muted-foreground">{m.project.code} · {m.project.client_name}{m.project.client_phone ? ` · ${m.project.client_phone}` : ""}</div>
                      </TableCell>
                      <TableCell>{m.label}{m.percent != null ? <span className="ml-1 text-xs text-muted-foreground">{Number(m.percent)}%</span> : null}</TableCell>
                      <TableCell className="text-sm">{m.due_on ? formatCalendarDate(m.due_on) : m.phase ? `After ${m.phase.name}` : "—"}</TableCell>
                      <TableCell><MilestoneBadge status={m.status} days={m.days_overdue} /></TableCell>
                      <TableCell className="text-right tabular-nums">{formatINR(m.amount)}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{formatINR(m.balance)}</TableCell>
                      <TableCell>{m.status !== "paid" ? <Button size="sm" variant="outline" onClick={() => setPaying(m)}><Wallet /> Record</Button> : null}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
          <DataPagination page={query.page} pageSize={query.pageSize} total={data.total} disabled={list.isFetching}
            onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s) })} />
        </div>
      )}
      {paying ? (
        <RecordForDue due={paying} onClose={() => setPaying(null)} onDone={list.refetch} />
      ) : null}
    </>
  );
}

function ReceivedList() {
  const me = useProfile();
  const { params, set } = useUrlState();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month")! : istToday().slice(0, 7);
  const from = `${month}-01`;
  const to = addDays(`${addDays(from, 32).slice(0, 7)}-01`, -1);
  const paging = parsePaging(params);
  const list = useLiveQuery({
    queryKey: `payments-received:${me.id}:${from}:${paging.page}:${paging.pageSize}`,
    fetcher: (s) => fetchPaymentsReceived({ from, to, ...paging }, s),
    tables: TABLES,
  });
  const shift = (n: number) => set({ month: addDays(n < 0 ? addDays(from, -1) : addDays(to, 1), 0).slice(0, 7), page: null });
  const d = list.data;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft /></Button>
        <span className="min-w-36 text-center font-medium">{formatMonthLong(from)}</span>
        <Button variant="outline" size="icon" aria-label="Next month" onClick={() => shift(1)}><ChevronRight /></Button>
        {d ? <span className="ml-2 text-sm text-muted-foreground">{formatINR(d.sum)} in {d.total} payment{d.total === 1 ? "" : "s"}
          {Object.keys(d.byMode).length ? ` · ${Object.entries(d.byMode).map(([m, v]) => `${PAYMENT_MODE_LABELS[m as PaymentMode] ?? m} ${formatINR(v)}`).join(" · ")}` : ""}</span> : null}
        <FetchingIndicator show={list.isFetching && !list.isInitialLoading} />
      </div>
      {list.error && !d ? <ErrorState message={list.error} onRetry={list.refetch} /> : list.isInitialLoading ? <ListSkeleton /> : !d?.total ? (
        <EmptyState title="No payments received this month" />
      ) : (
        <>
          <Card className="py-0">
            <ul className="divide-y">
              {d.items.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                  <span className="w-28 font-semibold tabular-nums">{formatINR(p.amount)}</span>
                  <span className="text-sm tabular-nums">{formatCalendarDate(p.paid_on)}</span>
                  <Link href={`/projects/${p.project.id}?tab=payments`} className="text-sm font-medium hover:underline">{p.project.name}</Link>
                  <span className="text-sm text-muted-foreground">{p.milestone ?? "Outside the schedule"} · {PAYMENT_MODE_LABELS[p.mode as PaymentMode] ?? p.mode}{p.reference ? ` · ${p.reference}` : ""}</span>
                  {p.received_by ? <span className="ml-auto text-xs text-muted-foreground">by {p.received_by}</span> : null}
                </li>
              ))}
            </ul>
          </Card>
          <DataPagination page={paging.page} pageSize={paging.pageSize} total={d.total} disabled={list.isFetching}
            onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s) })} />
        </>
      )}
    </>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" | "warn" }) {
  const color = tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-red-300" : tone === "warn" ? "text-amber-200" : "";
  return (
    <Card className="gap-1 py-3">
      <CardContent className="space-y-0.5 px-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

/** The record dialog needs the project's whole schedule: the money fills its parts oldest first. */
function RecordForDue({ due, onClose, onDone }: { due: PaymentDue; onClose: () => void; onDone: () => void }) {
  const me = useProfile();
  const schedule = useLiveQuery({
    queryKey: `project-payments:${me.id}:${due.project.id}`,
    fetcher: (s) => fetchPaymentStatus(due.project.id, s),
    tables: ["project_payment_milestones", "project_payments", "project_phases"],
  });
  if (!schedule.data) return null;
  return <PaymentDialog projectId={due.project.id} milestones={schedule.data.milestones} milestoneId={due.id} open onOpenChange={(o) => !o && onClose()} onDone={onDone} />;
}
