"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, History, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataPagination } from "@/components/common/data-pagination";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { CapitalDialog, ExpenseDialog, FinanceHistoryDialog } from "@/components/finance/finance-dialogs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { CATEGORY_LABELS, EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/constants";
import { formatINR } from "@/lib/format";
import { lastPage, parsePaging } from "@/lib/pagination";
import { fetchCapital, fetchDashboard, fetchExpenses, type CapitalRow, type ExpenseRow } from "@/lib/queries";
import { formatCalendarDate, formatMonth } from "@/lib/time";
import { cn } from "@/lib/utils";
import { setFinanceArchived } from "@/server/actions/finance";

export type FinanceSummary = {
  range: { from: string; to: string; months: number };
  total_capital: number; current_month: string; current_month_expenses: number;
  monthly: { month: string; total: number }[]; categories: { category: ExpenseCategory; total: number }[];
};

export function FinanceView() {
  const { params, set } = useUrlState();
  const tab = params.get("tab") === "capital" ? "capital" : "expenses";
  const summary = useLiveQuery({
    queryKey: "finance-summary",
    fetcher: (s) => fetchDashboard<FinanceSummary>("dashboard_finance", 12, s),
    tables: ["expenses", "capital_entries"],
  });
  const [expenseDialog, setExpenseDialog] = useState<{ open: boolean; row: ExpenseRow | null }>({ open: false, row: null });
  const [capitalDialog, setCapitalDialog] = useState<{ open: boolean; row: CapitalRow | null }>({ open: false, row: null });
  const [historyId, setHistoryId] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Finance"
        description="Capital invested and monthly operating expenses (INR). Profit and cash balance are not calculated."
        actions={tab === "expenses"
          ? <Button onClick={() => setExpenseDialog({ open: true, row: null })}><Plus /> Add expense</Button>
          : <Button onClick={() => setCapitalDialog({ open: true, row: null })}><Plus /> Add capital</Button>}
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-2">
        <SummaryCard title="Total contributed capital" value={summary.data ? formatINR(summary.data.total_capital) : null} hint="All active capital entries" />
        <SummaryCard
          title="This month's operating expenses"
          value={summary.data ? formatINR(summary.data.current_month_expenses) : null}
          hint={summary.data ? formatMonth(summary.data.current_month) : ""}
        />
      </div>
      <Tabs value={tab} onValueChange={(v) => set({ tab: v === "capital" ? "capital" : null, month: null, category: null, archived: null })} className="mb-3">
        <TabsList><TabsTrigger value="expenses">Expenses</TabsTrigger><TabsTrigger value="capital">Capital</TabsTrigger></TabsList>
      </Tabs>
      {tab === "expenses" ? (
        <ExpensesTable onEdit={(row) => setExpenseDialog({ open: true, row })} onHistory={setHistoryId} />
      ) : (
        <CapitalTable onEdit={(row) => setCapitalDialog({ open: true, row })} onHistory={setHistoryId} />
      )}
      <ExpenseDialog open={expenseDialog.open} onOpenChange={(o) => setExpenseDialog((s) => ({ ...s, open: o }))} expense={expenseDialog.row} onDone={summary.refetch} />
      <CapitalDialog open={capitalDialog.open} onOpenChange={(o) => setCapitalDialog((s) => ({ ...s, open: o }))} entry={capitalDialog.row} onDone={summary.refetch} />
      <FinanceHistoryDialog entityId={historyId} onClose={() => setHistoryId(null)} />
    </>
  );
}

function SummaryCard({ title, value, hint }: { title: string; value: string | null; hint: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value ?? <span className="inline-block h-7 w-32 animate-pulse rounded bg-muted" />}</CardTitle>
      </CardHeader>
      <CardContent className="-mt-3 text-xs text-muted-foreground">{hint}</CardContent>
    </Card>
  );
}

function useListPaging() {
  const { params, set } = useUrlState();
  return { params, set, paging: parsePaging(params), archived: params.get("archived") === "1" };
}

function RowMenu({ archived, onEdit, onHistory, kind, id, onDone }: { archived: boolean; onEdit: () => void; onHistory: () => void; kind: "expense" | "capital"; id: string; onDone: () => void }) {
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

function ExpensesTable({ onEdit, onHistory }: { onEdit: (r: ExpenseRow) => void; onHistory: (id: string) => void }) {
  const { params, set, paging, archived } = useListPaging();
  const month = /^\d{4}-\d{2}$/.test(params.get("month") ?? "") ? params.get("month") : null;
  const categoryParam = params.get("category");
  const category = EXPENSE_CATEGORIES.includes(categoryParam as ExpenseCategory) ? (categoryParam as ExpenseCategory) : null;
  const query = useMemo(() => ({ month, category, archived, ...paging }), [month, category, archived, paging]);
  const { data, error, isFetching, isInitialLoading, isStale, refetch } = useLiveQuery({
    queryKey: `expenses:${JSON.stringify(query)}`,
    fetcher: (s) => fetchExpenses(query, s),
    tables: ["expenses"],
  });
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
  }, [data, isStale, query.page, query.pageSize, set]);

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input type="month" className="w-[170px]" value={month ?? ""} onChange={(e) => set({ month: e.target.value || null })} aria-label="Month" />
        <Select value={category ?? "__all"} onValueChange={(v) => set({ category: v === "__all" ? null : v })}>
          <SelectTrigger className="w-[170px]" aria-label="Category"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All categories</SelectItem>
            {EXPENSE_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Label className="flex items-center gap-2 font-normal"><Checkbox checked={archived} onCheckedChange={(c) => set({ archived: c === true ? "1" : null })} /> Archived</Label>
        <FetchingIndicator show={isFetching && !isInitialLoading} />
      </div>
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : isInitialLoading ? <ListSkeleton /> : !data?.total ? (
        <EmptyState title="No expenses" description={month || category ? "Nothing matches these filters." : "Add the first operating expense."} />
      ) : (
        <div className={cn(isStale && "opacity-60")}>
          <Card className="py-0">
            <Table>
              <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Category</TableHead><TableHead className="hidden sm:table-cell">Description</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="w-10" /></TableRow></TableHeader>
              <TableBody>
                {data.items.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{formatCalendarDate(r.expense_date)}</TableCell>
                    <TableCell>{CATEGORY_LABELS[r.category]}</TableCell>
                    <TableCell className="hidden max-w-xs truncate text-muted-foreground sm:table-cell">{r.description ?? "—"}<span className="block text-xs">by {r.author?.display_name ?? "—"}</span></TableCell>
                    <TableCell className="text-right tabular-nums">{formatINR(r.amount)}</TableCell>
                    <TableCell><RowMenu archived={!!r.archived_at} kind="expense" id={r.id} onEdit={() => onEdit(r)} onHistory={() => onHistory(r.id)} onDone={refetch} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <DataPagination page={query.page} pageSize={query.pageSize} total={data.total} disabled={isFetching}
            onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s) })} />
        </div>
      )}
    </>
  );
}

function CapitalTable({ onEdit, onHistory }: { onEdit: (r: CapitalRow) => void; onHistory: (id: string) => void }) {
  const { set, paging, archived } = useListPaging();
  const query = useMemo(() => ({ archived, ...paging }), [archived, paging]);
  const { data, error, isFetching, isInitialLoading, isStale, refetch } = useLiveQuery({
    queryKey: `capital:${JSON.stringify(query)}`,
    fetcher: (s) => fetchCapital(query, s),
    tables: ["capital_entries"],
  });
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
  }, [data, isStale, query.page, query.pageSize, set]);

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <Label className="flex items-center gap-2 font-normal"><Checkbox checked={archived} onCheckedChange={(c) => set({ archived: c === true ? "1" : null })} /> Archived</Label>
        <FetchingIndicator show={isFetching && !isInitialLoading} />
      </div>
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : isInitialLoading ? <ListSkeleton /> : !data?.total ? (
        <EmptyState title="No capital entries" description="Record money contributed to the business." />
      ) : (
        <div className={cn(isStale && "opacity-60")}>
          <Card className="py-0">
            <Table>
              <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Contributor</TableHead><TableHead className="hidden sm:table-cell">Description</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="w-10" /></TableRow></TableHeader>
              <TableBody>
                {data.items.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">{formatCalendarDate(r.entry_date)}</TableCell>
                    <TableCell>{r.contributor}</TableCell>
                    <TableCell className="hidden max-w-xs truncate text-muted-foreground sm:table-cell">{r.description ?? "—"}<span className="block text-xs">by {r.author?.display_name ?? "—"}</span></TableCell>
                    <TableCell className="text-right tabular-nums">{formatINR(r.amount)}</TableCell>
                    <TableCell><RowMenu archived={!!r.archived_at} kind="capital" id={r.id} onEdit={() => onEdit(r)} onHistory={() => onHistory(r.id)} onDone={refetch} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <DataPagination page={query.page} pageSize={query.pageSize} total={data.total} disabled={isFetching}
            onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s) })} />
        </div>
      )}
    </>
  );
}
