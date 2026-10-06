"use client";

import { useState } from "react";
import {
  Clock, Copy, Download, Eye, FilePlus2, FileMinus2, FileText, Link2, Link2Off, MessageCircle, Send, Sparkles, X,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorState } from "@/components/common/states";
import { shareMessage } from "@/components/leads/share-files-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollBox } from "@/components/common/scroll-box";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveQuery } from "@/hooks/use-live-query";
import { shareUrl, whatsappUrl } from "@/lib/library";
import { fetchLeadShareSummary, fetchShareEvents, signLibraryUrls, type ShareEvent, type ShareSummary } from "@/lib/library-queries";
import { formatDateTime, formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { removeShareFile, revokeLeadShare } from "@/server/actions/shares";

const EVENTS_PAGE = 20;
const EVENTS_MAX = 500;

function linkStatus(link: ShareSummary["link"], now = new Date()) {
  if (!link) return { label: "No link yet", tone: "muted" as const, detail: "Share documents to create the customer's link." };
  if (link.expires_at && new Date(link.expires_at) <= now) {
    return { label: "Expired", tone: "muted" as const, detail: `Expired ${formatDateTime(link.expires_at)}. Share again to reactivate the same link.` };
  }
  return { label: "Active", tone: "live" as const, detail: link.expires_at ? `Expires ${formatDateTime(link.expires_at)}` : "Never expires" };
}

/** One link per lead: status, its documents with customer activity, and a timeline of everything. */
export function SharedLinksCard({ leadId, leadName, phone, profileId, canEdit, onShare }: {
  leadId: string; leadName: string; phone: string; profileId: string; canEdit: boolean; onShare: () => void;
}) {
  const [limit, setLimit] = useState(EVENTS_PAGE);
  const summary = useLiveQuery({
    queryKey: `share-summary:${profileId}:${leadId}`,
    fetcher: (s) => fetchLeadShareSummary(leadId, s),
    tables: ["lead_shares", "share_events", "library_files", "leads"],
  });
  const events = useLiveQuery({
    queryKey: `share-events:${profileId}:${leadId}:${limit}`,
    fetcher: (s) => fetchShareEvents(leadId, limit, s),
    tables: ["share_events", "leads"],
  });
  const thumbPaths = (summary.data?.files ?? []).map((f) => f.thumb_path).filter((p): p is string => !!p);
  const thumbs = useLiveQuery({
    queryKey: `share-summary-thumbs:${thumbPaths.join("|")}`,
    fetcher: () => signLibraryUrls(thumbPaths),
    enabled: thumbPaths.length > 0,
    pollMs: 300_000,
  });

  const s = summary.data;
  const link = s?.link ?? null;
  const status = linkStatus(link);
  const refresh = () => { summary.refetch(); events.refetch(); };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(shareUrl(link.token));
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link.");
    }
  };

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              Shared documents
              {s ? <Badge variant="outline" className={cn(status.tone === "live" ? "border-emerald-500/40 text-emerald-400" : "text-muted-foreground")}>{status.label}</Badge> : null}
            </CardTitle>
            <CardDescription className="mt-1">
              {s ? status.detail : " "}
              {link?.view_count ? ` · opened ${link.view_count}×, last ${formatRelative(link.last_viewed_at!)}` : link ? " · not opened yet" : ""}
            </CardDescription>
          </div>
          {canEdit ? <Button size="sm" onClick={onShare}><Send /> Share</Button> : null}
        </div>
        {link && canEdit ? (
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" variant="outline" onClick={() => void copy()}><Copy /> Copy link</Button>
            <Button size="xs" variant="outline" asChild>
              <a href={whatsappUrl(phone, `${shareMessage(leadName)}\n${shareUrl(link.token)}`)} target="_blank" rel="noopener noreferrer"><MessageCircle /> Send again</a>
            </Button>
            <ConfirmDialog
              trigger={<Button size="xs" variant="ghost"><Link2Off /> Revoke</Button>}
              title="Revoke this link?"
              description="The customer will see that the link is no longer available. Sharing again creates a new link."
              confirmLabel="Revoke"
              destructive
              onConfirm={async () => {
                const r = await revokeLeadShare({ id: link.share_id });
                if (!r.ok) { toast.error(r.error); return false; }
                toast.success("Link revoked");
                refresh();
              }}
            />
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5">
        {summary.isInitialLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : summary.error && !s ? (
          <ErrorState message={summary.error} onRetry={summary.refetch} />
        ) : s && s.files.length ? (
          <ScrollBox label="Documents in this link" className="max-h-64">
            <ul className="space-y-2">
              {s.files.map((f) => {
                const thumb = f.thumb_path ? thumbs.data?.[f.thumb_path] : undefined;
                return (
                  <li key={f.id} className="flex items-center gap-2.5 rounded-md border p-2">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
                      <img src={thumb} alt="" className="size-10 shrink-0 rounded border object-cover object-top" />
                    ) : (
                      <span className="flex size-10 shrink-0 items-center justify-center rounded border bg-muted/40"><FileText className="size-4 text-muted-foreground" /></span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={f.name}>{f.name}</p>
                      <p className={cn("truncate text-xs", f.views || f.downloads ? "text-foreground/80" : "text-muted-foreground")}>
                        {!f.available
                          ? "Archived in the Library: hidden from the customer"
                          : f.views || f.downloads
                            ? `Viewed ${f.views}× · Downloaded ${f.downloads}× · ${formatRelative(f.last_seen!)}`
                            : "Not opened yet"}
                      </p>
                    </div>
                    {canEdit && link ? (
                      <ConfirmDialog
                        trigger={<Button variant="ghost" size="icon-sm" aria-label={`Remove ${f.name} from the link`}><X /></Button>}
                        title={`Remove "${f.name}" from the link?`}
                        description="The customer won't see it any more. Its history stays in the timeline, and you can share it again later."
                        confirmLabel="Remove"
                        destructive
                        onConfirm={async () => {
                          const r = await removeShareFile({ shareId: link.share_id, fileId: f.id });
                          if (!r.ok) { toast.error(r.error); return false; }
                          toast.success(`Removed ${f.name}`);
                          refresh();
                        }}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </ScrollBox>
        ) : null}

        {s?.older_links.length && canEdit ? (
          <div className="rounded-md border border-dashed p-3 text-sm">
            <p className="font-medium">Older links still active</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Created before one link per lead. Revoke them if they are no longer needed.</p>
            <ScrollBox label="Older links" className="mt-2 max-h-32">
              <ul className="space-y-1.5">
                {s.older_links.map((o) => (
                  <li key={o.share_id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">{formatDateTime(o.created_at)} · {o.expires_at ? `expires ${formatDateTime(o.expires_at)}` : "never expires"}</span>
                    <ConfirmDialog
                      trigger={<Button size="xs" variant="ghost"><Link2Off /> Revoke</Button>}
                      title="Revoke this older link?"
                      description="The customer will see that it is no longer available."
                      confirmLabel="Revoke"
                      destructive
                      onConfirm={async () => {
                        const r = await revokeLeadShare({ id: o.share_id });
                        if (!r.ok) { toast.error(r.error); return false; }
                        toast.success("Older link revoked");
                        refresh();
                      }}
                    />
                  </li>
                ))}
              </ul>
            </ScrollBox>
          </div>
        ) : null}

        <div>
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Timeline</h3>
          {events.isInitialLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : events.error && !events.data ? (
            <ErrorState message={events.error} onRetry={events.refetch} />
          ) : !events.data?.items.length ? (
            <p className="text-sm text-muted-foreground">Nothing shared yet.</p>
          ) : (
            <ScrollBox label="Shared documents timeline" className="max-h-80">
              <ShareTimeline items={events.data.items} />
              {events.data.hasMore && limit < EVENTS_MAX ? (
                <Button variant="ghost" size="sm" className="mt-2" onClick={() => setLimit((l) => Math.min(l + EVENTS_PAGE, EVENTS_MAX))}>Show more</Button>
              ) : null}
            </ScrollBox>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  link_created: Link2,
  files_added: FilePlus2,
  file_removed: FileMinus2,
  opened: Eye,
  file_viewed: FileText,
  file_downloaded: Download,
  expiry_changed: Clock,
  revoked: Link2Off,
};

function describe(e: ShareEvent): { title: string; detail?: string } {
  const m = e.meta ?? {};
  const files = Array.isArray(m.files) ? (m.files as string[]) : [];
  const expiry = (v: unknown) => (typeof v === "string" ? `expires ${formatDateTime(v)}` : "never expires");
  switch (e.type) {
    case "link_created": return { title: "created the link", detail: `Link ${expiry(m.expires_at)}` };
    case "files_added": return { title: `shared ${files.length} ${files.length === 1 ? "document" : "documents"}`, detail: `${files.join(", ")} · link ${expiry(m.expires_at)}` };
    case "file_removed": return { title: `removed "${e.file_name ?? "a document"}" from the link` };
    case "opened": return { title: "opened the documents", detail: e.device ?? undefined };
    case "file_viewed": return { title: `viewed "${e.file_name ?? "a document"}"`, detail: e.device ?? undefined };
    case "file_downloaded": return { title: `downloaded "${e.file_name ?? "a document"}"`, detail: e.device ?? undefined };
    case "expiry_changed": return { title: m.revived ? "reactivated the link" : "changed the link expiry", detail: `Link ${expiry(m.to)}` };
    case "revoked": return { title: "revoked the link" };
    default: return { title: e.type.replaceAll("_", " ") };
  }
}

function ShareTimeline({ items }: { items: ShareEvent[] }) {
  return (
    <ol className="relative">
      {items.map((e, i) => {
        const customer = !e.actor;
        const Icon = ICONS[e.type] ?? Sparkles;
        const { title, detail } = describe(e);
        return (
          <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
            {i < items.length - 1 ? <span className="absolute top-8 bottom-0 left-[15px] w-px bg-border" aria-hidden /> : null}
            <span className={cn("relative z-[1] flex size-8 shrink-0 items-center justify-center rounded-full border bg-card", customer && "border-emerald-500/40 bg-emerald-500/10 text-emerald-400")}>
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-sm">
                <p><span className="font-medium">{customer ? "Customer" : e.actor!.display_name}</span> <span className="text-muted-foreground">{title}</span></p>
                <time className="text-xs text-muted-foreground" dateTime={e.created_at}>{formatDateTime(e.created_at)}</time>
              </div>
              {detail ? <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
