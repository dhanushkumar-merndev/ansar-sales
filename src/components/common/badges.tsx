import { AlertTriangle, BellOff, BellRing, Check, CircleDot, Clock, Trophy, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS, type LeadStatus, type ReminderState } from "@/lib/constants";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<LeadStatus, string> = {
  new: "border-white/25 bg-white/10 text-white font-medium",
  contacted: "border-sky-400/30 bg-sky-400/10 text-sky-300",
  interested: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  proposal_sent: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  won: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  lost: "border-white/10 bg-white/5 text-zinc-400",
};

export function StatusBadge({ status, className }: { status: LeadStatus; className?: string }) {
  const Icon = status === "won" ? Trophy : status === "lost" ? X : CircleDot;
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", STATUS_STYLE[status], className)}>
      <Icon className="size-3 shrink-0" aria-hidden />
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function DueBadge({ overdue, state }: { overdue: boolean; state?: "pending" | "completed" | "cancelled" }) {
  if (state === "completed") return <Badge variant="outline" className="gap-1 border-emerald-400/30 bg-emerald-400/10 text-emerald-300"><Check className="size-3" />Completed</Badge>;
  if (state === "cancelled") return <Badge variant="outline" className="gap-1 border-white/10 bg-white/5 text-zinc-400"><X className="size-3" />Cancelled</Badge>;
  if (overdue) return <Badge variant="outline" className="gap-1 border-red-400/30 bg-red-400/10 text-red-300"><AlertTriangle className="size-3" />Overdue</Badge>;
  return <Badge variant="outline" className="gap-1 border-white/10 bg-white/5 text-zinc-300"><Clock className="size-3" />Scheduled</Badge>;
}

const REMINDER_TEXT: Record<string, string> = {
  telegram_not_connected: "Telegram not connected",
  telegram_blocked: "Bot blocked in Telegram",
  max_attempts_reached: "Gave up after retries",
};

export function ReminderBadge({ reminder }: { reminder: { state: ReminderState; last_error: string | null; attempts: number } | null }) {
  if (!reminder) return null;
  if (reminder.state === "sent") return <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><BellRing className="size-3" />Reminder sent</span>;
  if (reminder.state === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-400" title={reminder.last_error ?? undefined}>
        <BellOff className="size-3" />Reminder failed{reminder.last_error ? `: ${REMINDER_TEXT[reminder.last_error] ?? reminder.last_error}` : ""}
      </span>
    );
  }
  if ((reminder.state === "pending" || reminder.state === "processing") && reminder.attempts > 0) {
    return <span className="inline-flex items-center gap-1 text-xs text-amber-400"><BellRing className="size-3" />Retrying reminder ({reminder.attempts})</span>;
  }
  return null;
}
