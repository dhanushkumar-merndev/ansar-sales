"use client";

import { ArchiveRestore, Archive, CalendarCheck, CalendarClock, CalendarX, Eye, Link2Off, Pencil, PhoneCall, Send, Sparkles, StickyNote, UserRoundCheck, ArrowRightLeft } from "lucide-react";
import { STATUS_LABELS, type LeadStatus } from "@/lib/constants";
import { CALL_OUTCOMES, type CallOutcome } from "@/lib/library";
import type { Activity } from "@/lib/queries";
import { formatDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  lead_created: Sparkles,
  note: StickyNote,
  note_corrected: Pencil,
  status_changed: ArrowRightLeft,
  assigned: UserRoundCheck,
  lead_updated: Pencil,
  lead_archived: Archive,
  lead_restored: ArchiveRestore,
  follow_up_scheduled: CalendarClock,
  follow_up_rescheduled: CalendarClock,
  follow_up_updated: CalendarClock,
  follow_up_completed: CalendarCheck,
  follow_up_cancelled: CalendarX,
  call_logged: PhoneCall,
  files_shared: Send,
  share_revoked: Link2Off,
  share_opened: Eye,
};

const status = (s: unknown) => STATUS_LABELS[s as LeadStatus] ?? String(s ?? "—");
const dt = (s: unknown) => (typeof s === "string" ? formatDateTime(s) : "—");

/** Turns an activity row into a readable sentence (never raw JSON). */
function describe(a: Activity): { title: string; detail?: React.ReactNode } {
  const m = a.meta ?? {};
  switch (a.type) {
    case "lead_created":
      return { title: "created the lead", detail: [m.niche && `Niche: ${m.niche}`, m.owner && `Owner: ${m.owner}`, `Status: ${status(m.status)}`].filter(Boolean).join(" · ") };
    case "note":
      return { title: a.edited_at ? "added a note (edited)" : "added a note", detail: <p className="whitespace-pre-wrap text-foreground">{a.body}</p> };
    case "note_corrected":
      return { title: "corrected a note", detail: <p className="whitespace-pre-wrap line-through decoration-muted-foreground/60">{String(m.previous_body ?? "")}</p> };
    case "status_changed":
      return { title: `changed status from ${status(m.from)} to ${status(m.to)}` };
    case "assigned":
      return { title: `reassigned the lead from ${m.from ?? "—"} to ${m.to ?? "—"}` };
    case "lead_updated": {
      const changes = (m.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
      return {
        title: "updated details",
        detail: (
          <ul className="space-y-0.5">
            {Object.entries(changes).map(([field, c]) => (
              <li key={field}><span className="font-medium text-foreground">{field}:</span> {String(c.from ?? "—")} → {String(c.to ?? "—")}</li>
            ))}
          </ul>
        ),
      };
    }
    case "lead_archived":
      return { title: "archived the lead" };
    case "lead_restored":
      return { title: "restored the lead" };
    case "follow_up_scheduled":
      return { title: "scheduled a follow-up", detail: `${m.task} · due ${dt(m.due_at)}` };
    case "follow_up_rescheduled":
      return { title: "rescheduled a follow-up", detail: `${m.task} · ${dt(m.from)} → ${dt(m.to)}` };
    case "follow_up_updated":
      return { title: "edited a follow-up", detail: `${m.previous_task} → ${m.task}` };
    case "follow_up_completed":
      return { title: "completed a follow-up", detail: <>{String(m.task ?? "")}{a.body ? <p className="mt-0.5 text-foreground">Outcome: {a.body}</p> : null}</> };
    case "follow_up_cancelled":
      return { title: "cancelled a follow-up", detail: String(m.task ?? "") };
    case "call_logged": {
      const outcome = CALL_OUTCOMES[m.outcome as CallOutcome];
      return {
        title: "called the lead",
        detail: outcome || a.body ? (
          <>
            {outcome ? <span>Outcome: <span className="font-medium text-foreground">{outcome}</span></span> : null}
            {a.body ? <p className="mt-0.5 whitespace-pre-wrap text-foreground">{a.body}</p> : null}
          </>
        ) : undefined,
      };
    }
    case "files_shared": {
      const files = Array.isArray(m.files) ? (m.files as string[]) : [];
      return {
        title: `shared ${files.length} ${files.length === 1 ? "file" : "files"} on WhatsApp`,
        detail: `${files.join(", ")} · ${typeof m.expires_at === "string" ? `link expires ${dt(m.expires_at)}` : "link never expires"}`,
      };
    }
    case "share_revoked":
      return { title: "revoked a shared link", detail: typeof m.shared_at === "string" ? `Shared ${dt(m.shared_at)}` : undefined };
    case "share_opened":
      return { title: "opened the shared documents for the first time", detail: typeof m.device === "string" ? m.device : undefined };
    default:
      return { title: a.type.replaceAll("_", " ") };
  }
}

export function Timeline({ items, renderNoteActions }: { items: Activity[]; renderNoteActions?: (a: Activity) => React.ReactNode }) {
  return (
    <ol className="relative space-y-0">
      {items.map((a, i) => {
        const Icon = ICONS[a.type] ?? Sparkles;
        const { title, detail } = describe(a);
        const isNote = a.type === "note";
        return (
          <li key={a.id} className="relative flex gap-3 pb-5 last:pb-0">
            {i < items.length - 1 ? <span className="absolute top-8 bottom-0 left-[15px] w-px bg-border" aria-hidden /> : null}
            <span className={cn("relative z-[1] flex size-8 shrink-0 items-center justify-center rounded-full border bg-card", isNote && "border-primary/30 bg-accent text-accent-foreground")}>
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
                <p><span className="font-medium">{a.actor?.display_name ?? (a.type === "share_opened" ? "Customer" : "System")}</span> <span className="text-muted-foreground">{title}</span></p>
                <time className="text-xs text-muted-foreground" dateTime={a.created_at}>{formatDateTime(a.created_at)}</time>
              </div>
              {detail ? <div className={cn("mt-1 text-sm text-muted-foreground", isNote && "rounded-md border bg-card px-3 py-2")}>{detail}</div> : null}
              {isNote && renderNoteActions ? <div className="mt-1">{renderNoteActions(a)}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
