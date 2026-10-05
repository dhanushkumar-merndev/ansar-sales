"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { DateField } from "@/components/common/date-time-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { CATEGORY_LABELS, EXPENSE_CATEGORIES, type ExpenseCategory } from "@/lib/constants";
import { formatINR } from "@/lib/format";
import { fetchFinanceHistory, type CapitalRow, type ExpenseRow } from "@/lib/queries";
import { formatCalendarDate, formatDateTime, istToday } from "@/lib/time";
import { saveCapital, saveExpense } from "@/server/actions/finance";

const amountText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function ExpenseDialog({ open, onOpenChange, expense, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; expense?: ExpenseRow | null; onDone: () => void }) {
  const [date, setDate] = useState("");
  const [category, setCategory] = useState<ExpenseCategory>("miscellaneous");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    setDate(expense?.expense_date ?? istToday());
    setCategory(expense?.category ?? "miscellaneous");
    setAmount(expense ? amountText(Number(expense.amount)) : "");
    setDescription(expense?.description ?? "");
    setErrors({});
  }, [open, expense]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveExpense({ id: expense?.id, expenseDate: date, category, amount: amount.replace(/,/g, ""), description });
      if (!r.ok) {
        setErrors(r.fieldErrors ?? { _: [r.error] });
        return;
      }
      toast.success(expense ? "Expense updated" : "Expense added");
      onOpenChange(false);
      onDone();
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{expense ? "Edit expense" : "Add expense"}</DialogTitle>
          <DialogDescription>Operating cost in INR. The accounting month follows the expense date.</DialogDescription>
        </DialogHeader>
        <form id="expense-form" onSubmit={submit} noValidate>
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.expenseDate}>
                <FieldLabel htmlFor="exp-date">Date</FieldLabel>
                <DateField id="exp-date" value={date} onChange={setDate} invalid={!!errors.expenseDate} />
                <FieldError>{errors.expenseDate?.[0]}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="exp-cat">Category</FieldLabel>
                <Select value={category} onValueChange={(v) => setCategory(v as ExpenseCategory)}>
                  <SelectTrigger id="exp-cat" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{EXPENSE_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            </div>
            <Field data-invalid={!!errors.amount}>
              <FieldLabel htmlFor="exp-amount">Amount (₹)</FieldLabel>
              <Input id="exp-amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!errors.amount} />
              <FieldError>{errors.amount?.[0]}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="exp-desc">Description <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
              <Textarea id="exp-desc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            {errors._ ? <FieldError>{errors._[0]}</FieldError> : null}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button type="submit" form="expense-form" disabled={pending}>{pending && <Loader2 className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CapitalDialog({ open, onOpenChange, entry, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; entry?: CapitalRow | null; onDone: () => void }) {
  const [date, setDate] = useState("");
  const [contributor, setContributor] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    setDate(entry?.entry_date ?? istToday());
    setContributor(entry?.contributor ?? "");
    setAmount(entry ? amountText(Number(entry.amount)) : "");
    setDescription(entry?.description ?? "");
    setErrors({});
  }, [open, entry]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveCapital({ id: entry?.id, entryDate: date, contributor, amount: amount.replace(/,/g, ""), description });
      if (!r.ok) {
        setErrors(r.fieldErrors ?? { _: [r.error] });
        return;
      }
      toast.success(entry ? "Capital entry updated" : "Capital entry added");
      onOpenChange(false);
      onDone();
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{entry ? "Edit capital entry" : "Add capital investment"}</DialogTitle>
          <DialogDescription>Money contributed to the business. Not counted as sales revenue.</DialogDescription>
        </DialogHeader>
        <form id="capital-form" onSubmit={submit} noValidate>
          <FieldGroup className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.entryDate}>
                <FieldLabel htmlFor="cap-date">Date</FieldLabel>
                <DateField id="cap-date" value={date} onChange={setDate} />
                <FieldError>{errors.entryDate?.[0]}</FieldError>
              </Field>
              <Field data-invalid={!!errors.amount}>
                <FieldLabel htmlFor="cap-amount">Amount (₹)</FieldLabel>
                <Input id="cap-amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!errors.amount} />
                <FieldError>{errors.amount?.[0]}</FieldError>
              </Field>
            </div>
            <Field data-invalid={!!errors.contributor}>
              <FieldLabel htmlFor="cap-from">Contributor / source</FieldLabel>
              <Input id="cap-from" maxLength={120} value={contributor} onChange={(e) => setContributor(e.target.value)} aria-invalid={!!errors.contributor} />
              <FieldError>{errors.contributor?.[0]}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="cap-desc">Description <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
              <Textarea id="cap-desc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            {errors._ ? <FieldError>{errors._[0]}</FieldError> : null}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button type="submit" form="capital-form" disabled={pending}>{pending && <Loader2 className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const FIELD_LABELS: Record<string, string> = { entry_date: "Date", expense_date: "Date", contributor: "Contributor", category: "Category", amount: "Amount", description: "Description" };
const show = (k: string, v: unknown) => (v === null || v === undefined || v === "" ? "—" : k === "amount" ? formatINR(v as number) : k.endsWith("_date") ? formatCalendarDate(String(v)) : k === "category" ? CATEGORY_LABELS[v as ExpenseCategory] ?? String(v) : String(v));

export function FinanceHistoryDialog({ entityId, onClose }: { entityId: string | null; onClose: () => void }) {
  const { data, error, isInitialLoading } = useLiveQuery({
    queryKey: `fin-history:${entityId}`,
    fetcher: (s) => fetchFinanceHistory(entityId!, s),
    enabled: !!entityId,
    tables: ["expenses", "capital_entries"],
    pollMs: 0,
  });
  return (
    <Dialog open={!!entityId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>History</DialogTitle><DialogDescription>Every change to this record.</DialogDescription></DialogHeader>
        {error ? <p className="text-sm text-destructive">{error}</p> : isInitialLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <ol className="space-y-3">
            {data?.map((h) => (
              <li key={h.id} className="text-sm">
                <p><span className="font-medium">{h.actor?.display_name ?? "System"}</span> <span className="text-muted-foreground">{h.action}</span> · <span className="text-xs text-muted-foreground">{formatDateTime(h.created_at)}</span></p>
                {h.action === "updated" ? (
                  <ul className="mt-0.5 text-muted-foreground">
                    {Object.entries(h.changes).map(([k, c]) => <li key={k}>{FIELD_LABELS[k] ?? k}: {show(k, c.from)} → {show(k, c.to)}</li>)}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
