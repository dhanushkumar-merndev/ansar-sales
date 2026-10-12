"use client";

import { useState, useTransition } from "react";
import { Archive, Calculator, MoreHorizontal, Pencil, Plus, Wallet } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { MilestoneBadge } from "@/components/projects/payments/milestone-badge";
import { MilestoneDialog, PaymentDialog, raiseContractValue } from "@/components/projects/payments/payment-dialogs";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useLiveQuery } from "@/hooks/use-live-query";
import { PAYMENT_MODE_LABELS, type PaymentMode } from "@/lib/constants";
import { formatINR } from "@/lib/format";
import { fetchPaymentStatus } from "@/lib/project-queries";
import type { Milestone, ProjectDetail, ProjectPayment } from "@/lib/projects";
import { formatCalendarDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { archiveMilestone, archivePayment, recalcMilestones } from "@/server/actions/project-payments";

/**
 * Payment schedule and payments received (Admin and Accounts only). Payments of any amount fill the parts
 * oldest first; what is left of a part stays due, with its alerts, until it is covered.
 */
export function ProjectPaymentsTab({ detail }: { detail: ProjectDetail }) {
  const me = useProfile();
  const projectId = detail.project.id;
  const q = useLiveQuery({
    queryKey: `project-payments:${me.id}:${projectId}`,
    fetcher: (s) => fetchPaymentStatus(projectId, s),
    tables: ["project_payment_milestones", "project_payments", "project_phases", "project_financials"],
  });
  const [paying, setPaying] = useState<{ milestoneId?: string | null; payment?: ProjectPayment | null } | null>(null);
  const [editingMs, setEditingMs] = useState<{ milestone: Milestone | null } | null>(null);
  const [pending, start] = useTransition();

  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.refetch} />;
  if (!q.data) return <ListSkeleton rows={4} />;
  const s = q.data;
  const money = s.money;
  // Missing totals (an older database) count as zero rather than showing ₹NaN.
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const towards = num(s.received) - num(s.extra);
  const balance = s.contract_value != null ? Math.max(num(s.contract_value) - towards, 0)
    : s.schedule_open != null ? num(s.schedule_open) : Math.max(num(s.scheduled) - towards, 0);
  const pct = s.contract_value ? Math.min(100, Math.round((towards / Number(s.contract_value)) * 100)) : 0;
  const scheduleGap = money && s.contract_value != null && s.scheduled != null ? Number(s.contract_value) - Number(s.scheduled) : 0;

  return (
    <div className="space-y-5">
      {money ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Contract value" value={s.contract_value != null ? formatINR(s.contract_value) : "Not set"} />
          <Stat label="Received" value={formatINR(s.received)} tone="good"
            hint={[s.contract_value ? `${pct}% of the value` : null, num(s.extra) > 0 ? `incl. ${formatINR(s.extra)} extra work` : null, num(s.ahead) > 0 ? `${formatINR(s.ahead)} ahead of the schedule` : null].filter(Boolean).join(" · ") || undefined} />
          <Stat label="Balance" value={balance != null ? formatINR(balance) : "—"} tone={balance ? "warn" : undefined} />
          <Stat label="Overdue parts" value={String(s.milestones.filter((m) => m.status === "overdue").length)} tone={s.milestones.some((m) => m.status === "overdue") ? "bad" : undefined} />
        </div>
      ) : null}

      <Card className="gap-0">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
          <CardTitle className="text-base">Payment schedule</CardTitle>
          {money ? (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={pending} onClick={() => start(async () => {
                const r = await recalcMilestones({ projectId });
                if (!r.ok) return void toast.error(r.error);
                toast.success("Amounts updated from the percentages");
                q.refetch();
              })}><Calculator /> From %</Button>
              <Button variant="outline" size="sm" onClick={() => setEditingMs({ milestone: null })}><Plus /> Add part</Button>
              <Button size="sm" onClick={() => setPaying({})}><Wallet /> Record payment</Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3">
          {money && scheduleGap !== 0 && s.contract_value ? (
            <div className={cn("flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm",
              scheduleGap > 0 ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "border-red-400/30 bg-red-400/10 text-red-200")}>
              <span className="flex-1">
                The parts add up to {formatINR(s.scheduled)}, {scheduleGap > 0 ? `${formatINR(scheduleGap)} less` : `${formatINR(-scheduleGap)} more`} than the contract value.
                {scheduleGap < 0 ? " Lower a part, or raise the contract value if the scope grew." : ""}
              </span>
              {scheduleGap < 0 ? (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
                  if (await raiseContractValue(projectId, detail.financials, Number(s.scheduled))) q.refetch();
                })}>Raise contract value to {formatINR(s.scheduled)}</Button>
              ) : null}
            </div>
          ) : null}
          {!s.milestones.length ? <EmptyState title="No payment schedule yet" description={money ? "Add the parts the client pays, e.g. Advance 30%." : undefined} /> : (
            <ol className="space-y-2">
              {s.milestones.map((m, i) => {
                const paidPct = m.amount ? Math.min(100, Math.round(((m.paid ?? 0) / m.amount) * 100)) : 0;
                return (
                  <li key={m.id} className="rounded-xl border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex size-7 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">{i + 1}</span>
                      <span className="font-medium">{m.label}</span>
                      {m.percent != null ? <span className="text-sm text-muted-foreground">{Number(m.percent)}%</span> : null}
                      <MilestoneBadge status={m.status} days={m.days_overdue} />
                      <span className="flex-1" />
                      {money && m.amount != null ? <span className="font-semibold tabular-nums">{formatINR(m.amount)}</span> : null}
                      {money ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${m.label}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {m.status !== "paid" ? <DropdownMenuItem onSelect={() => setPaying({ milestoneId: m.id })}><Wallet /> Record payment</DropdownMenuItem> : null}
                            <DropdownMenuItem onSelect={() => setEditingMs({ milestone: m })}><Pencil /> Edit</DropdownMenuItem>
                            <ConfirmDialog
                              trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}><Archive /> Remove</DropdownMenuItem>}
                              title={`Remove “${m.label}”?`} description="Payments already recorded against it stay, without a part." confirmLabel="Remove" destructive
                              onConfirm={async () => { const r = await archiveMilestone({ id: m.id }); if (!r.ok) { toast.error(r.error); return false; } q.refetch(); }}
                            />
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                    <div className="mt-1.5 pl-9 text-sm text-muted-foreground">
                      {m.due_trigger === "phase" ? <>When <span className="text-foreground">{m.phase?.name ?? "a removed phase"}</span> is done{m.due_on ? ` (done ${formatCalendarDate(m.due_on)})` : ""}</>
                        : <>Due {m.due_on ? formatCalendarDate(m.due_on) : "—"}</>}
                      {money && m.paid ? <> · paid {formatINR(m.paid)}{m.balance ? `, ${formatINR(m.balance)} left` : ""}</> : null}
                    </div>
                    {money && m.amount ? (
                      <div className="mt-2 ml-9 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={paidPct} aria-valuemin={0} aria-valuemax={100} aria-label={`${paidPct}% paid`}>
                        <div className="h-full rounded-full bg-emerald-400" style={{ width: `${paidPct}%` }} />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      {money ? (
        <Card className="gap-0">
          <CardHeader className="pb-3"><CardTitle className="text-base">Payments received</CardTitle></CardHeader>
          <CardContent>
            {!s.payments?.length ? <p className="text-sm text-muted-foreground">Nothing received yet.</p> : (
              <ul className="divide-y">
                {s.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <span className="w-28 font-semibold tabular-nums">{formatINR(p.amount)}</span>
                    <span className="text-sm">{formatCalendarDate(p.paid_on)}</span>
                    <span className="text-sm text-muted-foreground">{PAYMENT_MODE_LABELS[p.mode as PaymentMode] ?? p.mode}{p.reference ? ` · ${p.reference}` : ""}</span>
                    <span className="text-sm text-muted-foreground">{p.is_extra ? "Extra work" : "Schedule"}{p.received_by ? ` · by ${p.received_by}` : ""}</span>
                    <span className="flex-1" />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Payment actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setPaying({ payment: p })}><Pencil /> Correct</DropdownMenuItem>
                        <ConfirmDialog
                          trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}><Archive /> Remove</DropdownMenuItem>}
                          title="Remove this payment?" description="Use this for a payment entered by mistake. It stays in the history." confirmLabel="Remove" destructive
                          onConfirm={async () => { const r = await archivePayment({ id: p.id }); if (!r.ok) { toast.error(r.error); return false; } q.refetch(); }}
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      {money ? (
        <>
          <PaymentDialog projectId={projectId} milestones={s.milestones} payment={paying?.payment} milestoneId={paying?.milestoneId}
            open={!!paying} onOpenChange={(o) => !o && setPaying(null)} onDone={q.refetch} />
          <MilestoneDialog projectId={projectId} milestone={editingMs?.milestone} phases={detail.phases} contractValue={s.contract_value != null ? Number(s.contract_value) : null}
            otherParts={s.milestones.filter((m) => m.id !== editingMs?.milestone?.id).map((m) => Number(m.amount ?? 0))} financials={detail.financials}
            open={!!editingMs} onOpenChange={(o) => !o && setEditingMs(null)} onDone={q.refetch} />
        </>
      ) : null}
    </div>
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
