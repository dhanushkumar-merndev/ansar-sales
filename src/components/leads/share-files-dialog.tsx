"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Eye, Loader2, Plus, Save } from "lucide-react";
import { toast } from "sonner";
import { useProfile } from "@/components/providers/profile-provider";
import { LibraryFilePicker } from "@/components/library/file-picker";
import { ShareTemplateEditor, useShareTemplates } from "@/components/library/share-templates";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { SHARE_EXPIRY, SHARE_MAX_FILES, whatsappUrl, type ShareExpiry } from "@/lib/library";
import { fetchLeadShareSummary, fillShareMessage, type ShareableFile } from "@/lib/library-queries";
import { formatDateTime } from "@/lib/time";
import { shareLeadFiles } from "@/server/actions/shares";

type Created = { url: string; whatsapp: string; expiresAt: string | null };

const NO_TEMPLATE = "__none";

/** Default WhatsApp text that goes before the link. */
export const shareMessage = (leadName: string, companyName: string) => `Hi ${leadName.split(" ")[0]}, here are the documents from ${companyName}:`;

export function ShareFilesDialog({ open, onOpenChange, leadId, leadName, phone, onShared }: {
  open: boolean; onOpenChange: (o: boolean) => void; leadId: string; leadName: string; phone: string; onShared?: () => void;
}) {
  const [selected, setSelected] = useState<Map<string, ShareableFile>>(new Map());
  const [expiry, setExpiry] = useState<ShareExpiry>("7d");
  const [message, setMessage] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [editor, setEditor] = useState<"new" | "save" | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [pending, start] = useTransition();
  const [wasOpen, setWasOpen] = useState(false);
  const { company } = useProfile();
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setSelected(new Map()); setExpiry("7d"); setTemplateId(null); setEditor(null);
      setMessage(shareMessage(leadName, company.name)); setCreated(null);
    }
  }

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
  // What the customer's page shows today (a live link's available documents), for the preview.
  const inLinkNow = hasLink ? (current.data?.files ?? []).filter((f) => f.available).map((f) => f.id) : [];
  const templates = useShareTemplates(open && !created);
  const template = templates.data?.find((t) => t.id === templateId) ?? null;

  /** Fills the files (skipping ones already in the link or archived since), message and expiry. */
  const applyTemplate = (id: string | null) => {
    setTemplateId(id);
    const t = templates.data?.find((x) => x.id === id);
    if (!t) return;
    setSelected(new Map(t.files.filter((f) => f.available && !included.has(f.id)).slice(0, SHARE_MAX_FILES).map((f) => [f.id, f])));
    setMessage(fillShareMessage(t.message, leadName, company.name));
    setExpiry(t.expiry);
  };

  /** The customer's page as it will look: what's already in the link, then the picked files. */
  const preview = () => {
    const ids = [...inLinkNow, ...selected.keys()];
    const url = `/share-preview?${new URLSearchParams({ files: ids.join(","), lead: leadId, expiry })}`;
    window.open(url, "_blank", "noopener");
  };

  // What "Save as template" starts from: the picked files, and the message with this lead's name and the
  // company's name turned back into {name} / {company}, so the template fits every lead.
  const firstName = leadName.split(" ")[0] ?? "";
  const generic = (text: string) => {
    let t = text;
    if (company.name) t = t.split(company.name).join("{company}");
    if (firstName.length >= 2) t = t.split(firstName).join("{name}");
    return t;
  };
  const draft = { files: [...selected.values()], message: generic(message), expiry };

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
      {/* grid-cols-1 = minmax(0,1fr): wide content can't push the dialog past its border.
          The body scrolls between a fixed header and footer on short screens. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl">
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
          <div className="-mx-1 min-w-0 space-y-3 overflow-y-auto px-1 pb-1">
            <div className="flex items-end gap-2">
              <Field className="min-w-0 flex-1">
                <FieldLabel htmlFor="share-template">Template</FieldLabel>
                <Select value={templateId ?? NO_TEMPLATE} onValueChange={(v) => applyTemplate(v === NO_TEMPLATE ? null : v)}>
                  <SelectTrigger id="share-template" className="w-full">
                    <SelectValue placeholder={templates.isInitialLoading ? "Loading…" : "No template"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TEMPLATE} className="text-muted-foreground">No template</SelectItem>
                    {(templates.data ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name} · {t.files.length} {t.files.length === 1 ? "file" : "files"}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Button variant="outline" onClick={() => setEditor("new")}><Plus /> New template</Button>
            </div>
            {template && template.files.some((f) => !f.available) ? (
              <p className="text-xs text-amber-300">
                {template.files.filter((f) => !f.available).length === 1 ? "1 file in this template is" : `${template.files.filter((f) => !f.available).length} files in this template are`} no longer in the Library.
              </p>
            ) : null}

            <LibraryFilePicker enabled={open && !created} selected={selected} onChange={(next) => { setSelected(next); }} included={included} />

            <Field>
              <FieldLabel htmlFor="share-message">WhatsApp message</FieldLabel>
              {/* Long template messages scroll inside the box instead of stretching the dialog. */}
              <Textarea id="share-message" rows={4} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} className="max-h-48 resize-y" />
            </Field>
            <Field className="sm:max-w-52">
              <FieldLabel htmlFor="share-expiry">{hasLink ? "Reset expiry to" : "Link expires"}</FieldLabel>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as ShareExpiry)}>
                <SelectTrigger id="share-expiry" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(SHARE_EXPIRY) as ShareExpiry[]).map((k) => <SelectItem key={k} value={k}>{k === "never" ? "Never" : `In ${SHARE_EXPIRY[k]}`}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </div>
        )}

        <DialogFooter className="sm:flex-wrap">
          {created ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}><Check /> Done</Button>
              <Button asChild><a href={created.whatsapp} target="_blank" rel="noopener noreferrer">Open WhatsApp</a></Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending} className="sm:mr-auto">Cancel</Button>
              {selected.size ? <Button variant="ghost" onClick={() => setEditor("save")} disabled={pending}><Save /> Save as template</Button> : null}
              <Button variant="outline" onClick={preview} disabled={pending || (!selected.size && !inLinkNow.length)} title="See the customer's page before sending"><Eye /> Preview</Button>
              <Button onClick={submit} disabled={pending || !selected.size}>
                {pending && <Loader2 className="animate-spin" />}
                {selected.size ? `Share ${selected.size} ${selected.size === 1 ? "file" : "files"} on WhatsApp` : "Pick files to share"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
      <ShareTemplateEditor
        open={editor !== null}
        onOpenChange={(o) => !o && setEditor(null)}
        initial={editor === "save" ? draft : undefined}
        onSaved={(id) => { void templates.refetch().then(() => setTemplateId(id)); }}
      />
    </Dialog>
  );
}
