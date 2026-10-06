"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, ArrowDownRight, ArrowUpRight, Download, History, Loader2, MoreHorizontal, Pencil, Repeat, Search } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataPagination } from "@/components/common/data-pagination";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlSearch } from "@/hooks/use-url-search";
import { useUrlState } from "@/hooks/use-url-state";
import { CATEGORY_LABELS, EXPENSE_CATEGORIES, MAX_PAGE_SIZE, PAYMENT_MODE_LABELS, PAYMENT_MODES, type ExpenseCategory, type PaymentMode } from "@/lib/constants";
import { formatCount, formatINR } from "@/lib/format";
import { lastPage, parsePaging } from "@/lib/pagination";
import { fetchFinanceEntries, type CapitalRow, type ExpenseRow, type FinanceEntriesQuery, type FinanceKind, type FinanceSort } from "@/lib/queries";
import { formatCalendarDate } from "@/lib/time";
import { setFinanceArchived } from "@/server/actions/finance";

export function RowMenu({ archived, onEdit, onHistory, kind, id, onDone }: {
  archived: boolean; onEdit: () => void; onHistory: () => void; kind: FinanceKind; id: string; onDone: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Row actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!archived ? <DropdownMenuItem onSelect={onEdit}><Pencil /> Edit</DropdownMenuItem> : null}
        <DropdownMenuItem onSelect={onHistory}><History /> History</DropdownMenuItem>
        <ConfirmDialog
          trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}>{archived ? <><ArchiveRestore /> Restore</> : <><Archive /> Archive</>}</DropdownMenuItem>}
          title={archived ? "Restore this entry?" : "Archive this entry?"}
          description={archived ? "It will count in totals again." : "It is removed from totals but kept in history and can be restored."}
          confirmLabel={archived ? "Restore" : "Archive"}
          destructive={!archived}
          onConfirm={async () => {
            const r = await setFinanceArchived({ kind, id, archived: !archived });
            if (!r.ok) { toast.error(r.error); return false; }
            toast.success(archived ? "Restored" : "Archived");
            onDone();
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ItemLine({ item, quantity }: { item: string | null; quantity: number | null }) {
  if (!item) return null;
  return <span className="block text-xs font-normal text-muted-foreground">{item}{quantity ? ` × ${formatCount(quantity)} nos` : ""}</span>;
}

export function PaymentLine({ mode }: { mode: PaymentMode | null }) {
  return mode ? <span className="block text-xs text-muted-foreground">{PAYMENT_MODE_LABELS[mode]}</span> : null;
}

const SORTS: { value: FinanceSort; label: string }[] = [
  { value: "date-desc", label: "Newest first" },
  { value: "date-asc", label: "Oldest first" },
  { value: "amount-desc", label: "Highest amount" },
  { value: "amount-asc", label: "Lowest amount" },
];
const ALL = "__all";

/** Expense or capital entries of one period: search, filters, sort and paging live in the URL. */
export function FinanceEntries({ from, to, fileLabel, onEditExpense, onEditCapital, onHistory, onChanged }: {
  from: string; to: string; fileLabel: string;
  onEditExpense: (r: ExpenseRow) => void; onEditCapital: (r: CapitalRow) => void;
  onHistory: (kind: FinanceKind, id: string) => void; onChanged: () => void;
}) {
  const { params, set } = useUrlState();
  const { q, input, setInput } = useUrlSearch();
  const kind: FinanceKind = params.get("tab") === "capital" ? "capital" : "expense";
  const rawCategory = params.get("category");
  const category = kind === "expense" && EXPENSE_CATEGORIES.includes(rawCategory as ExpenseCategory) ? (rawCategory as ExpenseCategory) : null;
  const rawMode = params.get("mode");
  const mode = rawMode === "unspecified" || PAYMENT_MODES.includes(rawMode as PaymentMode) ? (rawMode as PaymentMode | "unspecified") : null;
  const recurring = kind === "expense" && params.get("recurring") === "1";
  const archived = params.get("archived") === "1";
  const sort = SORTS.find((s) => s.value === params.get("sort"))?.value ?? "date-desc";
  const { page, pageSize } = parsePaging(params);

  const query: FinanceEntriesQuery = useMemo(
    () => ({ kind, from, to, q, category, mode, recurring, archived, sort, page, pageSize }),
    [kind, from, to, q, category, mode, recurring, archived, sort, page, pageSize],
  );
  const { data, error, isFetching, isInitialLoading, isStale, refetch } = useLiveQuery({
    queryKey: `finance-entries:${JSON.stringify(query)}`,
    // Tagged with its kind: while the other tab loads, the previous rows stay on screen and must render as what they are.
    fetcher: async (s) => ({ kind: query.kind, ...(await fetchFinanceEntries<ExpenseRow | CapitalRow>(query, s)) }),
    tables: [kind === "expense" ? "expenses" : "capital_entries"],
  });
  // Archiving the last row of a page: move to the last valid page.
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && page > 1) set({ page: String(lastPage(data.total, pageSize)) }, { replace: true });
  }, [data, isStale, page, pageSize, set]);

  const changed = () => { refetch(); onChanged(); };
  const filtered = !!(q || category || mode || recurring || archived);

  return (
    <Card role="region" aria-label="Entries">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base">Entries{data ? <span className="ml-2 text-sm font-normal text-muted-foreground">{formatCount(data.total)}</span> : null}</CardTitle>
        <div className="flex items-center gap-2">
          <FetchingIndicator show={isFetching && !isInitialLoading} />
          <CsvButton query={query} fileLabel={fileLabel} disabled={!data?.total} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Tabs value={kind} onValueChange={(v) => set({ tab: v === "capital" ? "capital" : null, category: null, recurring: null })}>
          <TabsList><TabsTrigger value="expense">Expenses</TabsTrigger><TabsTrigger value="capital">Capital</TabsTrigger></TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" value={input} onChange={(e) => setInput(e.target.value)} maxLength={100}
              placeholder={kind === "expense" ? "Search item or description" : "Search contributor, item or description"} aria-label="Search entries" />
          </div>
          {kind === "expense" ? (
            <Select value={category ?? ALL} onValueChange={(v) => set({ category: v === ALL ? null : v })}>
              <SelectTrigger className="w-[calc(50%-0.25rem)] sm:w-40" aria-label="Category"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All categories</SelectItem>
                {EXPENSE_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
          <Select value={mode ?? ALL} onValueChange={(v) => set({ mode: v === ALL ? null : v })}>
            <SelectTrigger className="w-[calc(50%-0.25rem)] sm:w-40" aria-label="Mode of payment"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All payment modes</SelectItem>
              {PAYMENT_MODES.map((m) => <SelectItem key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</SelectItem>)}
              <SelectItem value="unspecified">Not recorded</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => set({ sort: v === "date-desc" ? null : v })}>
            <SelectTrigger className="w-[calc(50%-0.25rem)] sm:w-40" aria-label="Sort"><SelectValue /></SelectTrigger>
            <SelectContent>{SORTS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
          {kind === "expense" ? (
            <Label className="flex cursor-pointer items-center gap-2 text-xs font-normal text-muted-foreground select-none hover:text-foreground">
              <Checkbox checked={recurring} onCheckedChange={(c) => set({ recurring: c === true ? "1" : null })} />Monthly only
            </Label>
          ) : null}
          <Label className="flex cursor-pointer items-center gap-2 text-xs font-normal text-muted-foreground select-none hover:text-foreground">
            <Checkbox checked={archived} onCheckedChange={(c) => set({ archived: c === true ? "1" : null })} />Archived
          </Label>
        </div>

        {error && !data ? <ErrorState message={error} onRetry={refetch} /> : isInitialLoading || !data ? <ListSkeleton rows={5} /> : data.items.length === 0 ? (
          <EmptyState title={kind === "expense" ? "No expenses" : "No capital entries"} description={filtered ? "Nothing matches these filters." : "Nothing recorded in this period."} />
        ) : (
          <div className={isStale ? "opacity-60" : undefined}>
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>{data.kind === "expense" ? "Category" : "Contributor"}</TableHead>
                    <TableHead className="hidden sm:table-cell">Description</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.kind === "expense" ? (data.items as ExpenseRow[]).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">{formatCalendarDate(r.expense_date)}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5">
                          {CATEGORY_LABELS[r.category]}
                          {r.recurrence?.active ? <Badge variant="outline" className="gap-1 text-[10px]" title={`Next: ${formatCalendarDate(r.recurrence.next_date)}`}><Repeat className="size-3" />Monthly</Badge> : null}
                        </span>
                        <ItemLine item={r.item} quantity={r.quantity} />
                      </TableCell>
                      <TableCell className="hidden max-w-xs truncate text-muted-foreground sm:table-cell">{r.description ?? "—"}<span className="block text-xs">by {r.author?.display_name ?? "—"}</span></TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="inline-flex items-center gap-1 text-sm font-semibold text-rose-400"><ArrowDownRight className="size-3.5 shrink-0" />−{formatINR(r.amount)}</span>
                        <PaymentLine mode={r.payment_mode} />
                      </TableCell>
                      <TableCell><RowMenu archived={!!r.archived_at} kind="expense" id={r.id} onEdit={() => onEditExpense(r)} onHistory={() => onHistory("expense", r.id)} onDone={changed} /></TableCell>
                    </TableRow>
                  )) : (data.items as CapitalRow[]).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">{formatCalendarDate(r.entry_date)}</TableCell>
                      <TableCell className="font-medium text-foreground">{r.contributor}<ItemLine item={r.item} quantity={r.quantity} /></TableCell>
                      <TableCell className="hidden max-w-xs truncate text-muted-foreground sm:table-cell">{r.description ?? "—"}<span className="block text-xs">by {r.author?.display_name ?? "—"}</span></TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-400"><ArrowUpRight className="size-3.5 shrink-0" />+{formatINR(r.amount)}</span>
                        <PaymentLine mode={r.payment_mode} />
                      </TableCell>
                      <TableCell><RowMenu archived={!!r.archived_at} kind="capital" id={r.id} onEdit={() => onEditCapital(r)} onHistory={() => onHistory("capital", r.id)} onDone={changed} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <DataPagination inline page={page} pageSize={pageSize} total={data.total} disabled={isFetching}
              onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s) })} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const CSV_LIMIT = 5000;

/** Downloads every entry matching the current filters (paged 100 at a time, up to 5,000 rows). */
function CsvButton({ query, fileLabel, disabled }: { query: FinanceEntriesQuery; fileLabel: string; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    const controller = new AbortController();
    try {
      const rows: (ExpenseRow | CapitalRow)[] = [];
      for (let page = 1; rows.length < CSV_LIMIT; page++) {
        const r = await fetchFinanceEntries<ExpenseRow | CapitalRow>({ ...query, page, pageSize: MAX_PAGE_SIZE }, controller.signal);
        rows.push(...r.items);
        if (!r.hasNextPage) break;
      }
      const csv = toCsv(query.kind, rows.slice(0, CSV_LIMIT));
      const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${query.kind === "expense" ? "expenses" : "capital"}-${fileLabel}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      if (rows.length > CSV_LIMIT) toast.message(`Downloaded the first ${formatCount(CSV_LIMIT)} rows.`);
    } catch {
      toast.error("Could not prepare the download. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="outline" size="sm" onClick={download} disabled={disabled || busy}>
      {busy ? <Loader2 className="animate-spin" /> : <Download />}Download CSV
    </Button>
  );
}

/** Spreadsheet-safe cell: quoted when needed, and never starting with a formula character. */
function cell(value: unknown) {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(kind: FinanceKind, rows: (ExpenseRow | CapitalRow)[]) {
  const mode = (m: PaymentMode | null) => (m ? PAYMENT_MODE_LABELS[m] : "");
  const lines = kind === "expense"
    ? [["Date", "Category", "Item", "Nos", "Amount (INR)", "Mode of payment", "Monthly", "Description", "Recorded by"],
      ...(rows as ExpenseRow[]).map((r) => [r.expense_date, CATEGORY_LABELS[r.category], r.item, r.quantity, Number(r.amount).toFixed(2), mode(r.payment_mode),
        r.recurrence?.active ? "Yes" : "", r.description, r.author?.display_name])]
    : [["Date", "Contributor", "Item", "Nos", "Amount (INR)", "Mode of payment", "Description", "Recorded by"],
      ...(rows as CapitalRow[]).map((r) => [r.entry_date, r.contributor, r.item, r.quantity, Number(r.amount).toFixed(2), mode(r.payment_mode),
        r.description, r.author?.display_name])];
  return lines.map((l) => l.map(cell).join(",")).join("\r\n");
}
