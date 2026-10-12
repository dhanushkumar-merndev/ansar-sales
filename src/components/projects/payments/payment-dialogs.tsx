"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { DateField } from "@/components/common/date-time-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PAYMENT_MODE_LABELS, PAYMENT_MODES, type PaymentMode } from "@/lib/constants";
import { formatINR } from "@/lib/format";
import { allocatePayment, scheduleExcess, scheduleExcessMessage, sumAmounts, type Milestone, type Phase, type ProjectDetail, type ProjectPayment } from "@/lib/projects";
import { istToday } from "@/lib/time";
import { saveMilestone, savePayment } from "@/server/actions/project-payments";
import { setProjectFinancials } from "@/server/actions/projects";

/**
 * Accounts or Admin raises the contract value (keeping area and rate), e.g. when the scope grew and the
 * schedule now asks for more. Returns whether it worked; it says why in a toast when it didn't.
 */
export async function raiseContractValue(projectId: string, financials: ProjectDetail["financials"], to: number) {
  const r = await setProjectFinancials({
    projectId, contractValue: to.toFixed(2),
    areaSqft: financials?.area_sqft != null ? String(financials.area_sqft) : "",
    ratePerSqft: financials?.rate_per_sqft != null ? String(financials.rate_per_sqft) : "",
  });
  if (!r.ok) { toast.error(r.error); return false; }
  toast.success(`Contract value raised to ${formatINR(to)}`);
  return true;
}

const REFERENCE_HINT: Partial<Record<PaymentMode, string>> = {
  upi: "UPI / UTR number", bank_transfer: "UTR / transaction ID", cheque: "Cheque number and bank", card: "Last 4 digits / approval code",
};

/**
 * Record (or correct) a payment received from the client. Any amount: a schedule payment fills the
 * parts oldest first (the rest of a part stays due), an extra is work outside the schedule.
 */
export function PaymentDialog({ projectId, milestones, payment, milestoneId, open, onOpenChange, onDone }: {
  projectId: string; milestones: Milestone[]; payment?: ProjectPayment | null; milestoneId?: string | null;
  open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void;
}) {
  const init = () => {
    const part = milestones.find((x) => x.id === milestoneId);
    // Suggest what is due now (or the next open part), never more than is left.
    const dueNow = milestones.filter((m) => m.status === "due" || m.status === "partly_paid" || m.status === "overdue")
      .reduce((sum, m) => sum + Number(m.balance ?? 0), 0);
    const nextOpen = milestones.find((m) => Number(m.balance ?? 0) > 0);
    const suggested = part?.balance ? Number(part.balance) : dueNow > 0 ? dueNow : Number(nextOpen?.balance ?? 0);
    return {
      isExtra: payment?.is_extra ?? false,
      amount: payment ? String(payment.amount) : suggested > 0 ? String(Math.round(suggested * 100) / 100) : "",
      paidOn: payment?.paid_on ?? istToday(),
      mode: (payment?.mode ?? "upi") as PaymentMode,
      reference: payment?.reference ?? "",
      notes: payment?.notes ?? "",
    };
  };
  const [form, setForm] = useState(init);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) { setForm(init()); setErrors({}); }
  }
  const set = <K extends keyof ReturnType<typeof init>>(k: K, v: ReturnType<typeof init>[K]) => setForm((f) => ({ ...f, [k]: v }));
  const amount = Number(form.amount);
  // A correction is applied after the old amount is taken back out, so only preview new payments.
  const plan = !payment && !form.isExtra && amount > 0 ? allocatePayment(milestones, amount) : null;
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{payment ? "Correct payment" : "Record payment"}</DialogTitle>
          <DialogDescription>Any amount the client paid. Attach the proof (screenshot, cheque photo, receipt) in the project&apos;s Payment proofs folder.</DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="pm-for">For</FieldLabel>
            <Select value={form.isExtra ? "extra" : "schedule"} onValueChange={(v) => set("isExtra", v === "extra")}>
              <SelectTrigger id="pm-for" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="schedule">The payment schedule (oldest part first)</SelectItem>
                <SelectItem value="extra">Extra work — not part of the schedule</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field data-invalid={!!errors.amount}>
              <FieldLabel htmlFor="pm-amount">Amount (₹)</FieldLabel>
              <Input id="pm-amount" inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} />
              <FieldError errors={errors.amount?.map((message) => ({ message }))} />
              {amount > 0 ? <FieldDescription>{formatINR(form.amount)}</FieldDescription> : null}
            </Field>
            <Field><FieldLabel htmlFor="pm-date">Received on</FieldLabel><DateField id="pm-date" value={form.paidOn} onChange={(v) => set("paidOn", v)} /></Field>
          </div>
          {plan ? (
            <div className="rounded-md border px-3 py-2 text-sm" aria-live="polite">
              {plan.parts.length ? (
                <ul className="space-y-0.5">
                  {plan.parts.map((x) => (
                    <li key={x.id} className="flex justify-between gap-2">
                      <span>{x.label}</span>
                      <span className="tabular-nums">{formatINR(x.applied)} {x.clears ? <span className="text-emerald-300">· cleared</span> : <span className="text-amber-300">· rest stays due</span>}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-muted-foreground">Every part is already paid.</p>}
              {plan.ahead > 0 ? <p className="mt-1 text-amber-300">{formatINR(plan.ahead)} is more than the whole schedule (shown as paid ahead).</p> : null}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="pm-mode">Mode</FieldLabel>
              <Select value={form.mode} onValueChange={(v) => set("mode", v as PaymentMode)}>
                <SelectTrigger id="pm-mode" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{PAYMENT_MODES.map((m) => <SelectItem key={m} value={m}>{PAYMENT_MODE_LABELS[m]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="pm-ref">Reference</FieldLabel>
              <Input id="pm-ref" value={form.reference} maxLength={120} placeholder={REFERENCE_HINT[form.mode] ?? "Optional"} onChange={(e) => set("reference", e.target.value)} />
            </Field>
          </div>
          <Field><FieldLabel htmlFor="pm-notes">Notes</FieldLabel><Textarea id="pm-notes" rows={2} value={form.notes} maxLength={1000} onChange={(e) => set("notes", e.target.value)} /></Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button disabled={pending || !form.amount} onClick={() => start(async () => {
            const r = await savePayment({ projectId, id: payment?.id, version: payment?.version, ...form });
            if (!r.ok) { setErrors(r.fieldErrors ?? {}); toast.error(r.error); return; }
            toast.success(payment ? "Payment corrected" : `${formatINR(form.amount)} recorded`);
            onOpenChange(false);
            onDone();
          })}>{pending && <Loader2 className="animate-spin" />}{payment ? "Save" : "Record"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Add or edit a part of the payment schedule. */
export function MilestoneDialog({ projectId, milestone, phases, contractValue, otherParts, financials, open, onOpenChange, onDone }: {
  projectId: string; milestone?: Milestone | null; phases: Phase[]; contractValue: number | null;
  /** Amounts of the schedule's other parts, to stop the schedule asking for more than the contract value. */
  otherParts: number[]; financials: ProjectDetail["financials"];
  open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void;
}) {
  const init = () => ({
    label: milestone?.label ?? "", percent: milestone?.percent != null ? String(milestone.percent) : "",
    amount: milestone?.amount != null ? String(milestone.amount) : "", dueTrigger: (milestone?.due_trigger ?? "date") as "date" | "phase",
    dueDate: milestone?.due_date ?? istToday(), phaseId: milestone?.phase?.id ?? phases[0]?.id ?? "", notes: milestone?.notes ?? "",
  });
  const [form, setForm] = useState(init);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) { setForm(init()); setErrors({}); }
  }
  const set = <K extends keyof ReturnType<typeof init>>(k: K, v: ReturnType<typeof init>[K]) => setForm((f) => ({ ...f, [k]: v }));
  const fromPercent = contractValue && Number(form.percent) > 0 ? Math.round(contractValue * Number(form.percent)) / 100 : null;
  const total = sumAmounts([...otherParts, form.amount || 0]);
  const over = scheduleExcess(contractValue, total);

  const persist = async () => {
    const r = await saveMilestone({ projectId, id: milestone?.id, version: milestone?.version, ...form, phaseId: form.phaseId || undefined });
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      if (r.code === "schedule_over_value") warnOver(); else toast.error(r.error);
      return;
    }
    toast.success("Payment schedule saved");
    onOpenChange(false);
    onDone();
  };
  // Nothing is saved: the toast says why and offers to raise the contract value to fit.
  const warnOver = () => toast.error(scheduleExcessMessage(total, contractValue), {
    duration: 12_000,
    action: { label: `Raise to ${formatINR(total)}`, onClick: () => start(async () => { if (await raiseContractValue(projectId, financials, total)) await persist(); }) },
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{milestone ? "Edit payment part" : "Add payment part"}</DialogTitle><DialogDescription>When the client pays this part, and how much.</DialogDescription></DialogHeader>
        <FieldGroup className="gap-4">
          <Field data-invalid={!!errors.label}><FieldLabel htmlFor="ms-label">Name</FieldLabel><Input id="ms-label" value={form.label} maxLength={80} placeholder="e.g. Advance" onChange={(e) => set("label", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field data-invalid={!!errors.percent}><FieldLabel htmlFor="ms-pct">Percent</FieldLabel><Input id="ms-pct" inputMode="decimal" value={form.percent} onChange={(e) => set("percent", e.target.value)} placeholder="30" /></Field>
            <Field data-invalid={!!errors.amount || over > 0}>
              <FieldLabel htmlFor="ms-amount">Amount (₹)</FieldLabel><Input id="ms-amount" inputMode="decimal" value={form.amount} aria-invalid={over > 0} onChange={(e) => set("amount", e.target.value)} />
              {fromPercent != null ? <button type="button" className="text-left text-xs text-sky-300 hover:underline" onClick={() => set("amount", fromPercent.toFixed(2))}>Use {form.percent}% = {formatINR(fromPercent)}</button> : null}
            </Field>
          </div>
          {over > 0 ? (
            <p className="-mt-1 text-sm text-red-300" role="alert">
              All parts would come to {formatINR(total)}, {formatINR(over)} over the contract value ({formatINR(contractValue)}).
            </p>
          ) : null}
          <Field>
            <FieldLabel htmlFor="ms-trigger">Due</FieldLabel>
            <Select value={form.dueTrigger} onValueChange={(v) => set("dueTrigger", v as "date" | "phase")}>
              <SelectTrigger id="ms-trigger" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="date">On a date</SelectItem><SelectItem value="phase" disabled={!phases.length}>When a phase is done</SelectItem></SelectContent>
            </Select>
          </Field>
          {form.dueTrigger === "date" ? (
            <Field data-invalid={!!errors.dueDate}><FieldLabel htmlFor="ms-date">Due date</FieldLabel><DateField id="ms-date" value={form.dueDate} onChange={(v) => set("dueDate", v)} /></Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="ms-phase">Phase</FieldLabel>
              <Select value={form.phaseId} onValueChange={(v) => set("phaseId", v)}>
                <SelectTrigger id="ms-phase" className="w-full"><SelectValue placeholder="Choose a phase" /></SelectTrigger>
                <SelectContent>{phases.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button disabled={pending || !form.label.trim() || !form.amount} onClick={() => (over > 0 ? warnOver() : start(persist))}>{pending && <Loader2 className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
