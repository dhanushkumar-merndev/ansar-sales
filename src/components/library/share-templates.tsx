"use client";

import { useState, useTransition } from "react";
import { Archive, ArchiveRestore, Loader2, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "@/components/common/states";
import { fileIcon, LibraryFilePicker } from "@/components/library/file-picker";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { SHARE_EXPIRY, type ShareExpiry } from "@/lib/library";
import { fetchShareTemplates, type ShareableFile, type ShareTemplate } from "@/lib/library-queries";
import { saveShareTemplate, setShareTemplateArchived } from "@/server/actions/share-templates";

/** Today's default WhatsApp text, with the placeholders a template fills in per lead. */
export const DEFAULT_TEMPLATE_MESSAGE = "Hi {name}, here are the documents from {company}:";

export const expiryLabel = (k: ShareExpiry) => (k === "never" ? "Never expires" : `Expires in ${SHARE_EXPIRY[k]}`);

/** The company's active (or archived) templates; read fresh, kept per user. */
export function useShareTemplates(enabled: boolean, archived = false) {
  const profile = useProfile();
  return useLiveQuery({
    queryKey: `share-templates:${profile.id}:${archived}`,
    fetcher: (s) => fetchShareTemplates({ archived }, s),
    tables: ["share_templates", "share_template_files", "library_files"],
    enabled,
    keep: true,
  });
}

/** Only its creator or an admin may change a template (the database checks again). */
export function useCanManageTemplate() {
  const profile = useProfile();
  return (t: Pick<ShareTemplate, "created_by">) => profile.role === "admin" || t.created_by === profile.id;
}

type Draft = { files: ShareableFile[]; message: string; expiry: ShareExpiry };

/** Create (no template) or edit a template: name, files, link expiry and WhatsApp message. */
export function ShareTemplateEditor({ open, onOpenChange, template, initial, onSaved }: {
  open: boolean; onOpenChange: (o: boolean) => void; template?: ShareTemplate | null; initial?: Draft; onSaved?: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Map<string, ShareableFile>>(new Map());
  const [expiry, setExpiry] = useState<ShareExpiry>("7d");
  const [message, setMessage] = useState(DEFAULT_TEMPLATE_MESSAGE);
  const [pending, start] = useTransition();
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      const files = template ? template.files.filter((f) => f.available) : (initial?.files ?? []);
      setName(template?.name ?? "");
      setSelected(new Map(files.map((f) => [f.id, f])));
      setExpiry(template?.expiry ?? initial?.expiry ?? "7d");
      setMessage(template?.message ?? initial?.message ?? DEFAULT_TEMPLATE_MESSAGE);
    }
  }

  const save = () => start(async () => {
    const r = await saveShareTemplate({ id: template?.id, name, message, expiry, fileIds: [...selected.keys()] });
    if (!r.ok) return void toast.error(r.fieldErrors ? Object.values(r.fieldErrors).flat()[0] ?? r.error : r.error);
    toast.success(template ? "Template saved" : `Template "${name.trim()}" created`);
    onSaved?.(r.data.id);
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{template ? "Edit template" : "New share template"}</DialogTitle>
          <DialogDescription>Pick it while sharing and it fills in the documents, the message and the expiry. Everything stays editable before sending.</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3">
          <Field>
            <FieldLabel htmlFor="tpl-name">Name</FieldLabel>
            <Input id="tpl-name" maxLength={80} placeholder="e.g. Coorg plots brochure pack" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <LibraryFilePicker enabled={open} selected={selected} onChange={setSelected} />
          {template && template.files.some((f) => !f.available) ? (
            <p className="text-xs text-amber-300">
              {template.files.filter((f) => !f.available).length} file(s) in this template were archived in the Library and are left out.
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
            <Field>
              <FieldLabel htmlFor="tpl-expiry">Link expires</FieldLabel>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as ShareExpiry)}>
                <SelectTrigger id="tpl-expiry" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(SHARE_EXPIRY) as ShareExpiry[]).map((k) => <SelectItem key={k} value={k}>{k === "never" ? "Never" : `In ${SHARE_EXPIRY[k]}`}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="tpl-message">WhatsApp message</FieldLabel>
              <Textarea id="tpl-message" rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
              <FieldDescription className="text-xs">{"{name}"} becomes the customer&apos;s first name, {"{company}"} your company.</FieldDescription>
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button onClick={save} disabled={pending || !name.trim() || !selected.size}>
            {pending && <Loader2 className="animate-spin" />}{template ? "Save template" : "Create template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Library → Templates: list, create, edit, archive and restore share templates. */
export function ShareTemplatesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<ShareTemplate | null | "new">(null);
  const templates = useShareTemplates(open, archived);
  const canManage = useCanManageTemplate();
  const [busy, setBusy] = useState<string | null>(null);

  const setArchivedFor = async (t: ShareTemplate, value: boolean) => {
    setBusy(t.id);
    const r = await setShareTemplateArchived({ id: t.id, archived: value });
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    toast.success(value ? `"${t.name}" archived` : `"${t.name}" restored`);
    templates.refetch();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[calc(100svh-4rem)] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Share templates</DialogTitle>
            <DialogDescription>Ready-made sets of documents with their WhatsApp message, picked in one click from Share files.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={archived} onCheckedChange={setArchived} /> Show archived
            </label>
            <Button size="sm" onClick={() => setEditing("new")}><Plus /> New template</Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {templates.error && !templates.data ? (
              <ErrorState message={templates.error} onRetry={templates.refetch} />
            ) : templates.isInitialLoading ? (
              <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
            ) : !templates.data?.length ? (
              <EmptyState
                title={archived ? "No archived templates" : "No templates yet"}
                description={archived ? "Archived templates show here and can be restored." : "Create one for the documents you send most, like a project brochure with its price list."}
              />
            ) : (
              <ul className="divide-y rounded-md border">
                {templates.data.map((t) => (
                  <li key={t.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="truncate font-medium">{t.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t.files.length} {t.files.length === 1 ? "file" : "files"} · {expiryLabel(t.expiry)}
                        {t.files.some((f) => !f.available) ? <span className="text-amber-300"> · {t.files.filter((f) => !f.available).length} archived in the Library</span> : null}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {t.files.map((f) => {
                          const Icon = fileIcon(f.mime_type);
                          return (
                            <span key={f.id} className={`inline-flex max-w-56 items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${f.available ? "" : "line-through opacity-50"}`}>
                              <Icon className="size-3 shrink-0" /><span className="truncate">{f.name}</span>
                            </span>
                          );
                        })}
                      </div>
                      {t.message ? <p className="line-clamp-2 text-xs text-muted-foreground">“{t.message}”</p> : null}
                    </div>
                    {canManage(t) ? (
                      <div className="flex shrink-0 gap-1.5">
                        {archived ? (
                          <Button size="sm" variant="outline" disabled={busy === t.id} onClick={() => void setArchivedFor(t, false)}><ArchiveRestore /> Restore</Button>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" onClick={() => setEditing(t)}><Pencil /> Edit</Button>
                            <Button size="sm" variant="ghost" disabled={busy === t.id} onClick={() => void setArchivedFor(t, true)}><Archive /> Archive</Button>
                          </>
                        )}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ShareTemplateEditor
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        template={editing === "new" ? null : editing}
        onSaved={() => templates.refetch()}
      />
    </>
  );
}
