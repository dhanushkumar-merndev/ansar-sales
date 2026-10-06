"use client";

import { useId, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ErrorState } from "@/components/common/states";
import { DateField } from "@/components/common/date-time-field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { CategoryCombobox, CompanySelect, useFinanceBooks, type CategoryValue } from "@/components/finance/finance-books";
import { categoryLabel, PAYMENT_MODE_LABELS, PAYMENT_MODES, type PaymentMode } from "@/lib/constants";
import { formatINR } from "@/lib/format";
import { fetchFinanceHistory, fetchItemSuggestions, type CapitalRow, type ExpenseRow } from "@/lib/queries";
import { formatCalendarDate, formatDateTime, istToday } from "@/lib/time";
import { saveCapital, saveExpense } from "@/server/actions/finance";

const amountText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const dayOfMonth = (date: string) => Number(date.slice(8, 10));
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

type Purchase = { paymentMode: PaymentMode | ""; item: string; quantity: string };
const emptyPurchase = (row?: { payment_mode: PaymentMode | null; item: string | null; quantity: number | null } | null): Purchase => ({
  paymentMode: row?.payment_mode ?? "", item: row?.item ?? "", quantity: row?.quantity ? String(row.quantity) : "",
});

/** Mode of payment, then an optional item (with suggestions from earlier entries) and its quantity in nos. */
function PurchaseFields({ prefix, kind, category, value, onChange, errors }: {
  prefix: string; kind: "expense" | "capital"; category: string | null; value: Purchase;
  onChange: (v: Purchase) => void; errors: Record<string, string[]>;
}) {
  const listId = useId();
  const suggestions = useLiveQuery({
    queryKey: `item-suggestions:${kind}:${category ?? ""}`,
    fetcher: (s) => fetchItemSuggestions(kind, category, s),
    pollMs: 0,
  });
  return (
    <>
      <Field data-invalid={!!errors.paymentMode}>
        <FieldLabel htmlFor={`${prefix}-mode`}>Mode of payment</FieldLabel>
        <Select value={value.paymentMode} onValueChange={(v) => onChange({ ...value, paymentMode: v as PaymentMode })}>
          <SelectTrigger id={`${prefix}-mode`} className="w-full" aria-invalid={!!errors.paymentMode}><SelectValue placeholder="Choose how it was paid" /></SelectTrigger>
          <SelectContent>{PAYMENT_MODES.map((m) => <SelectItem key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <div className="grid grid-cols-[1fr_6.5rem] gap-4">
        <Field data-invalid={!!errors.item}>
          <FieldLabel htmlFor={`${prefix}-item`}>Item <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
          <Input id={`${prefix}-item`} list={listId} maxLength={120} autoComplete="off" placeholder={kind === "expense" ? "e.g. Canva, ChatGPT" : "e.g. Chair"}
            value={value.item} onChange={(e) => onChange({ ...value, item: e.target.value })} aria-invalid={!!errors.item} />
          <datalist id={listId}>{suggestions.data?.map((s) => <option key={s} value={s} />)}</datalist>
        </Field>
        <Field data-invalid={!!errors.quantity}>
          <FieldLabel htmlFor={`${prefix}-qty`}>Nos</FieldLabel>
          <Input id={`${prefix}-qty`} inputMode="numeric" placeholder="0" value={value.quantity}
            onChange={(e) => onChange({ ...value, quantity: e.target.value })} aria-invalid={!!errors.quantity} />
        </Field>
      </div>
    </>
  );
}

const purchasePayload = (p: Purchase) => ({ paymentMode: p.paymentMode || undefined, item: p.item, quantity: p.quantity.replace(/,/g, "") });

export function ExpenseDialog({ open, onOpenChange, expense, defaultDate, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; expense?: ExpenseRow | null; defaultDate?: string; onDone: () => void;
}) {
  const [date, setDate] = useState("");
  const books = useFinanceBooks().data;
  const [category, setCategory] = useState<CategoryValue>(null);
  const [companyId, setCompanyId] = useState("");
  const [amount, setAmount] = useState("");
  const [purchase, setPurchase] = useState<Purchase>(emptyPurchase());
  const [repeat, setRepeat] = useState(false);
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();

  // Reset the form whenever the dialog opens (React's "adjust state on prop change" pattern).
  const [openedFor, setOpenedFor] = useState<{ open: boolean; expense?: ExpenseRow | null }>({ open: false });
  if (openedFor.open !== open || openedFor.expense !== expense) {
    setOpenedFor({ open, expense });
    if (open) {
      setDate(expense?.expense_date ?? defaultDate ?? istToday());
      setCategory(expense ? { id: expense.category_id, label: expense.category } : null);
      setCompanyId(expense?.company?.id ?? "");
      setAmount(expense ? amountText(Number(expense.amount)) : "");
      setPurchase(emptyPurchase(expense));
      setRepeat(!!expense?.recurrence?.active);
      setDescription(expense?.description ?? "");
      setErrors({});
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveExpense({
        id: expense?.id, expenseDate: date, companyId: companyId || undefined,
        category: category ? { id: category.id, newName: category.newName } : {}, amount: amount.replace(/,/g, ""), ...purchasePayload(purchase), description, repeatMonthly: repeat,
      });
      if (!r.ok) {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
        return;
      }
      toast.success(expense ? "Expense updated" : "Expense added");
      onOpenChange(false);
      onDone();
    });
  };

  const day = date ? dayOfMonth(date) : null;
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-md">
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
              </Field>
              <Field data-invalid={!!errors.category}>
                <FieldLabel htmlFor="exp-cat">Category</FieldLabel>
                <CategoryCombobox id="exp-cat" value={category} onChange={setCategory} categories={books?.categories ?? []}
                  allowCreate={books?.canEdit ?? false} invalid={!!errors.category} />
              </Field>
            </div>
            {books?.merged ? (
              <Field>
                <FieldLabel htmlFor="exp-company">Company</FieldLabel>
                <CompanySelect id="exp-company" value={companyId || books.currentCompanyId} onChange={setCompanyId} companies={books.companies} />
                <FieldDescription>These books are shared. Pick the company this expense is for.</FieldDescription>
              </Field>
            ) : null}
            <Field data-invalid={!!errors.amount}>
              <FieldLabel htmlFor="exp-amount">Amount (₹)</FieldLabel>
              <Input id="exp-amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!errors.amount} />
            </Field>
            <PurchaseFields prefix="exp" kind="expense" category={category?.id ?? null} value={purchase} onChange={setPurchase} errors={errors} />
            <Field>
              <FieldLabel htmlFor="exp-desc">Description <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
              <Textarea id="exp-desc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="exp-repeat" checked={repeat} onCheckedChange={(c) => setRepeat(c === true)} />
              <FieldContent>
                <FieldLabel htmlFor="exp-repeat">Repeat every month</FieldLabel>
                <FieldDescription>
                  {repeat
                    ? `Added automatically on the ${day ? ordinal(day) : "same day"} of each month (or the month's last day), with a Telegram message to Admin and Account.`
                    : expense?.recurrence?.active ? "Unticking stops future months. Past entries stay." : "For rent, salaries and subscriptions."}
                </FieldDescription>
              </FieldContent>
            </Field>
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

export function CapitalDialog({ open, onOpenChange, entry, defaultDate, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; entry?: CapitalRow | null; defaultDate?: string; onDone: () => void;
}) {
  const [date, setDate] = useState("");
  const [contributor, setContributor] = useState("");
  const [amount, setAmount] = useState("");
  const [purchase, setPurchase] = useState<Purchase>(emptyPurchase());
  const [description, setDescription] = useState("");
  const [companyId, setCompanyId] = useState("");
  const books = useFinanceBooks().data;
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();

  const [openedFor, setOpenedFor] = useState<{ open: boolean; entry?: CapitalRow | null }>({ open: false });
  if (openedFor.open !== open || openedFor.entry !== entry) {
    setOpenedFor({ open, entry });
    if (open) {
      setDate(entry?.entry_date ?? defaultDate ?? istToday());
      setContributor(entry?.contributor ?? "");
      setAmount(entry ? amountText(Number(entry.amount)) : "");
      setPurchase(emptyPurchase(entry));
      setDescription(entry?.description ?? "");
      setCompanyId(entry?.company?.id ?? "");
      setErrors({});
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await saveCapital({ id: entry?.id, entryDate: date, companyId: companyId || undefined, contributor, amount: amount.replace(/,/g, ""), ...purchasePayload(purchase), description });
      if (!r.ok) {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
        return;
      }
      toast.success(entry ? "Capital entry updated" : "Capital entry added");
      onOpenChange(false);
      onDone();
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-md">
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
              </Field>
              <Field data-invalid={!!errors.amount}>
                <FieldLabel htmlFor="cap-amount">Amount (₹)</FieldLabel>
                <Input id="cap-amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!errors.amount} />
              </Field>
            </div>
            <Field data-invalid={!!errors.contributor}>
              <FieldLabel htmlFor="cap-from">Contributor / source</FieldLabel>
              <Input id="cap-from" maxLength={120} value={contributor} onChange={(e) => setContributor(e.target.value)} aria-invalid={!!errors.contributor} />
            </Field>
            {books?.merged ? (
              <Field>
                <FieldLabel htmlFor="cap-company">Company</FieldLabel>
                <CompanySelect id="cap-company" value={companyId || books.currentCompanyId} onChange={setCompanyId} companies={books.companies} />
                <FieldDescription>These books are shared. Pick the company this capital is for.</FieldDescription>
              </Field>
            ) : null}
            <PurchaseFields prefix="cap" kind="capital" category={null} value={purchase} onChange={setPurchase} errors={errors} />
            <Field>
              <FieldLabel htmlFor="cap-desc">Description <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
              <Textarea id="cap-desc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
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

const FIELD_LABELS: Record<string, string> = { company: "Company", entry_date: "Date", expense_date: "Date", contributor: "Contributor", category: "Category", amount: "Amount", payment_mode: "Mode of payment", item: "Item", quantity: "Nos", description: "Description" };
const show = (k: string, v: unknown) => (v === null || v === undefined || v === "" ? "—" : k === "amount" ? formatINR(v as number) : k.endsWith("_date") ? formatCalendarDate(String(v)) : k === "category" ? categoryLabel(String(v)) : k === "payment_mode" ? PAYMENT_MODE_LABELS[v as PaymentMode] ?? String(v) : String(v));

export type FinanceEntity = { kind: "expense" | "capital"; id: string };

export function FinanceHistoryDialog({ entity, onClose }: { entity: FinanceEntity | null; onClose: () => void }) {
  const { data, error, isInitialLoading } = useLiveQuery({
    queryKey: `fin-history:${entity?.kind}:${entity?.id}`,
    fetcher: (s) => fetchFinanceHistory(entity!, s),
    enabled: !!entity,
    tables: ["expenses", "capital_entries"],
    pollMs: 0,
  });
  return (
    <Dialog open={!!entity} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>History</DialogTitle><DialogDescription>Every change to this record.</DialogDescription></DialogHeader>
        {error && !data ? <ErrorState message={error} /> : isInitialLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
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
