"use client";

import { useState, useTransition } from "react";
import { Check, Copy, FileText, ImageIcon, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { useProfile } from "@/components/providers/profile-provider";
import { ErrorState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { formatBytes, isImageMime, SHARE_EXPIRY, SHARE_MAX_FILES, whatsappUrl, type ShareExpiry } from "@/lib/library";
import { fetchFolderOptions, fetchLeadShareSummary, searchShareableFiles, signLibraryUrls, type ShareableFile } from "@/lib/library-queries";
import { cleanSearch } from "@/lib/search";
import { formatDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { shareLeadFiles } from "@/server/actions/shares";

type Created = { url: string; whatsapp: string; expiresAt: string | null };

/** Default WhatsApp text that goes before the link. */
export const shareMessage = (leadName: string, companyName: string) => `Hi ${leadName.split(" ")[0]}, here are the documents from ${companyName}:`;

export function ShareFilesDialog({ open, onOpenChange, leadId, leadName, phone, onShared }: {
  open: boolean; onOpenChange: (o: boolean) => void; leadId: string; leadName: string; phone: string; onShared?: () => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Map<string, ShareableFile>>(new Map());
  const [expiry, setExpiry] = useState<ShareExpiry>("7d");
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [pending, start] = useTransition();
  const [wasOpen, setWasOpen] = useState(false);
  const { company } = useProfile();
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setFolderId(null); setSearch(""); setSelected(new Map()); setExpiry("7d");
      setMessage(shareMessage(leadName, company.name)); setCreated(null);
    }
  }

  const q = useDebouncedValue(cleanSearch(search), SEARCH_DEBOUNCE_MS);
  const folders = useLiveQuery({ queryKey: "share-folders", fetcher: fetchFolderOptions, tables: ["library_folders"], enabled: open });
  // The lead's existing link: its documents are shown as already included.
  const current = useLiveQuery({
    queryKey: `share-summary-dialog:${leadId}`,
    fetcher: (s) => fetchLeadShareSummary(leadId, s),
    tables: ["lead_shares"],
    enabled: open && !created,
    pollMs: 0,
  });
  const hasLink = !!current.data?.link && !(current.data.link.expires_at && new Date(current.data.link.expires_at) <= new Date());
  const included = new Set((current.data?.files ?? []).map((f) => f.id));
  const files = useLiveQuery({
    queryKey: `share-files:${folderId}:${q}`,
    fetcher: (s) => searchShareableFiles({ q, folderId }, s),
    tables: ["library_files", "library_folders"],
    enabled: open && !created,
  });
  // Small previews for the listed files: one batched signing request.
  const thumbPaths = (files.data ?? []).map((f) => f.thumb_path).filter((p): p is string => !!p);
  const thumbs = useLiveQuery({
    queryKey: `share-thumbs:${thumbPaths.join("|")}`,
    fetcher: () => signLibraryUrls(thumbPaths),
    enabled: open && !created && thumbPaths.length > 0,
    pollMs: 300_000,
  });

  const toggle = (f: ShareableFile) =>
    setSelected((cur) => {
      const next = new Map(cur);
      if (next.has(f.id)) next.delete(f.id);
      else if (next.size < SHARE_MAX_FILES) next.set(f.id, f);
      else toast.error(`You can share up to ${SHARE_MAX_FILES} files at once.`);
      return next;
    });

  const submit = () => {
    if (!selected.size || pending) return;
    // Open the tab inside the click so popup blockers allow it; it's pointed at WhatsApp once the link exists.
    const win = window.open("", "_blank");
    if (win) win.opener = null;
    start(async () => {
      const r = await shareLeadFiles({ leadId, fileIds: [...selected.keys()], expiry });
      if (!r.ok) { win?.close(); toast.error(r.error); return; }
      const text = [message.trim(), r.data.url].filter(Boolean).join("\n");
      const wa = whatsappUrl(phone, text);
      setCreated({ url: r.data.url, whatsapp: wa, expiresAt: r.data.expiresAt });
      if (win) win.location.href = wa;
      const what = r.data.created
        ? "Link created"
        : r.data.added
          ? `Added ${r.data.added} ${r.data.added === 1 ? "document" : "documents"} to the link`
          : "Link expiry updated";
      toast.success(win ? `${what} · WhatsApp opened` : what);
      onShared?.();
    });
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it manually.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{created ? "Link ready" : "Share files on WhatsApp"}</DialogTitle>
          <DialogDescription>
            {created
              ? "WhatsApp opened in a new tab with the message. If it didn't, use the buttons below."
              : hasLink
                ? `Adds to ${leadName}'s existing link, so the URL stays the same. Documents already in it are ticked.`
                : `${leadName} gets one link with the documents you pick. Later shares add to the same link. It never shows their name or number.`}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
              <Button variant="outline" size="icon" onClick={() => void copy(created.url)} aria-label="Copy link"><Copy /></Button>
            </div>
            <p className="text-sm text-muted-foreground">{created.expiresAt ? `Expires ${formatDateTime(created.expiresAt)}.` : "This link never expires."} You can revoke it from the lead page.</p>
          </div>
        ) : (
          <div className="min-w-0 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={folderId ?? "__all"} onValueChange={(v) => setFolderId(v === "__all" ? null : v)}>
                <SelectTrigger className="w-full sm:w-44" aria-label="Folder"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All folders</SelectItem>
                  {(folders.data ?? []).map((f) => <SelectItem key={f.id} value={f.id}>{f.path}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input className="pl-8" placeholder="Search files" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search files" />
              </div>
            </div>

            <div className="max-h-56 overflow-y-auto rounded-md border" aria-busy={files.isFetching}>
              {files.error && !files.data ? (
                <div className="p-2"><ErrorState message={files.error} onRetry={files.refetch} /></div>
              ) : files.isInitialLoading ? (
                <div className="space-y-1 p-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
              ) : !files.data?.length ? (
                <p className="p-4 text-center text-sm text-muted-foreground">{q || folderId ? "No files match." : "The library is empty. Upload files from Library first."}</p>
              ) : (
                <ul className={cn("divide-y", files.isStale && "opacity-60")}>
                  {files.data.map((f) => {
                    const inLink = included.has(f.id);
                    const checked = inLink || selected.has(f.id);
                    const Icon = isImageMime(f.mime_type) ? ImageIcon : FileText;
                    const thumb = f.thumb_path ? thumbs.data?.[f.thumb_path] : undefined;
                    return (
                      <li key={f.id}>
                        <label className={cn("flex items-center gap-3 px-3 py-2", inLink ? "opacity-60" : "cursor-pointer hover:bg-white/[0.04]")}>
                          <Checkbox checked={checked} disabled={inLink} onCheckedChange={() => toggle(f)} aria-label={inLink ? `${f.name} is already in the link` : undefined} />
                          {thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
                            <img src={thumb} alt="" className="size-10 shrink-0 rounded border object-cover object-top" />
                          ) : (
                            <span className="flex size-10 shrink-0 items-center justify-center rounded border bg-muted/40"><Icon className="size-4 text-muted-foreground" /></span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{f.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">{inLink ? "Already in the link · " : ""}{f.folder.name} · {formatBytes(f.size_bytes)}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {selected.size ? (
              <div className="flex flex-wrap gap-1.5" aria-label="Selected files">
                {[...selected.values()].map((f) => (
                  <Badge key={f.id} variant="outline" className="max-w-full gap-1 pr-1">
                    <span className="truncate">{f.name}</span>
                    <button type="button" className="rounded-full p-0.5 hover:bg-white/10" onClick={() => toggle(f)} aria-label={`Remove ${f.name}`}><X className="size-3" /></button>
                  </Badge>
                ))}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
              <Field>
                <FieldLabel htmlFor="share-expiry">{hasLink ? "Reset expiry to" : "Link expires"}</FieldLabel>
                <Select value={expiry} onValueChange={(v) => setExpiry(v as ShareExpiry)}>
                  <SelectTrigger id="share-expiry" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(SHARE_EXPIRY) as ShareExpiry[]).map((k) => <SelectItem key={k} value={k}>{k === "never" ? "Never" : `In ${SHARE_EXPIRY[k]}`}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="share-message">WhatsApp message</FieldLabel>
                <Textarea id="share-message" rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
              </Field>
            </div>
          </div>
        )}

        <DialogFooter>
          {created ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}><Check /> Done</Button>
              <Button asChild><a href={created.whatsapp} target="_blank" rel="noopener noreferrer">Open WhatsApp</a></Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
              <Button onClick={submit} disabled={pending || !selected.size}>
                {pending && <Loader2 className="animate-spin" />}
                {selected.size ? `Share ${selected.size} ${selected.size === 1 ? "file" : "files"} on WhatsApp` : "Pick files to share"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
