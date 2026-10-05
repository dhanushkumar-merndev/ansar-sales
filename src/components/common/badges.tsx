import { AlertTriangle, BellOff, BellRing, Check, CircleDot, Clock, Trophy, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS, type LeadStatus, type ReminderState } from "@/lib/constants";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<LeadStatus, string> = {
  new: "border-slate-200 bg-slate-50 text-slate-700",
  contacted: "border-sky-200 bg-sky-50 text-sky-800",
  interested: "border-amber-200 bg-amber-50 text-amber-800",
  proposal_sent: "border-violet-200 bg-violet-50 text-violet-800",
  won: "border-emerald-200 bg-emerald-50 text-emerald-800",
  lost: "border-zinc-200 bg-zinc-100 text-zinc-600",
};

export function StatusBadge({ status, className }: { status: LeadStatus; className?: string }) {
  const Icon = status === "won" ? Trophy : status === "lost" ? X : CircleDot;
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", STATUS_STYLE[status], className)}>
      <Icon className="size-3" aria-hidden />
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function DueBadge({ overdue, state }: { overdue: boolean; state?: "pending" | "completed" | "cancelled" }) {
  if (state === "completed") return <Badge variant="outline" className="gap-1 border-emerald-200 bg-emerald-50 text-emerald-800"><Check className="size-3" />Completed</Badge>;
  if (state === "cancelled") return <Badge variant="outline" className="gap-1 text-muted-foreground"><X className="size-3" />Cancelled</Badge>;
  if (overdue) return <Badge variant="outline" className="gap-1 border-red-200 bg-red-50 text-red-700"><AlertTriangle className="size-3" />Overdue</Badge>;
  return <Badge variant="outline" className="gap-1 text-muted-foreground"><Clock className="size-3" />Scheduled</Badge>;
}

const REMINDER_TEXT: Record<string, string> = {
  telegram_not_connected: "Telegram not connected",
  telegram_blocked: "Bot blocked in Telegram",
  max_attempts_reached: "Gave up after retries",
};

export function ReminderBadge({ reminder }: { reminder: { state: ReminderState; last_error: string | null; attempts: number } | null }) {
  if (!reminder) return null;
  if (reminder.state === "sent") return <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><BellRing className="size-3" />Reminder sent</span>;
  if (reminder.state === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-700" title={reminder.last_error ?? undefined}>
        <BellOff className="size-3" />Reminder failed{reminder.last_error ? `: ${REMINDER_TEXT[reminder.last_error] ?? reminder.last_error}` : ""}
      </span>
    );
  }
  if ((reminder.state === "pending" || reminder.state === "processing") && reminder.attempts > 0) {
    return <span className="inline-flex items-center gap-1 text-xs text-amber-700"><BellRing className="size-3" />Retrying reminder ({reminder.attempts})</span>;
  }
  return null;
}
