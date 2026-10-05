"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Phone } from "lucide-react";
import { DueBadge, ReminderBadge, StatusBadge } from "@/components/common/badges";
import { CompleteFollowUpDialog, FollowUpDialog } from "@/components/follow-ups/follow-up-dialogs";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatRelative } from "@/lib/time";
import type { FollowUpListItem } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Compact task rows (used on the Follow-ups page and the Sales dashboard). */
export function FollowUpList({ items, showAssignee, onChanged }: { items: FollowUpListItem[]; showAssignee?: boolean; onChanged: () => void }) {
  const [completing, setCompleting] = useState<FollowUpListItem | null>(null);
  const [rescheduling, setRescheduling] = useState<FollowUpListItem | null>(null);
  return (
    <>
      <ul className="divide-y rounded-lg border bg-card">
        {items.map((f) => (
          <li key={f.id} className={cn("flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between", f.overdue && "bg-red-50/40")}>
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/leads/${f.lead.id}`} className="font-medium hover:underline">{f.lead.name}</Link>
                <StatusBadge status={f.lead.status} />
                <DueBadge overdue={f.overdue} state={f.state} />
              </div>
              <p className="text-sm">{f.task}</p>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span className={cn(f.overdue && "font-medium text-red-700")}>
                  {f.state === "completed" && f.completed_at ? `Completed ${formatDateTime(f.completed_at)}` : `${formatDateTime(f.due_at)} · ${formatRelative(f.due_at)}`}
                </span>
                <a href={`tel:${f.lead.phone.replace(/\s/g, "")}`} className="inline-flex items-center gap-1 hover:underline"><Phone className="size-3" />{f.lead.phone}</a>
                {showAssignee ? <span>{f.assignee.display_name}</span> : null}
              </p>
              {f.outcome ? <p className="text-xs text-muted-foreground">Outcome: {f.outcome}</p> : null}
              {f.state === "pending" ? <ReminderBadge reminder={f.reminder} /> : null}
            </div>
            {f.state === "pending" ? (
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" onClick={() => setCompleting(f)}><Check /> Complete</Button>
                <Button size="sm" variant="outline" onClick={() => setRescheduling(f)}>Reschedule</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <CompleteFollowUpDialog open={!!completing} onOpenChange={(o) => !o && setCompleting(null)} followUp={completing} onDone={onChanged} />
      <FollowUpDialog open={!!rescheduling} onOpenChange={(o) => !o && setRescheduling(null)} followUp={rescheduling ?? undefined} onDone={onChanged} />
    </>
  );
}
