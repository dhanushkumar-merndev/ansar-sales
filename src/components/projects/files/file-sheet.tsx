"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Archive, Check, CheckCircle2, Download, Eye, Loader2, Maximize2, MessageSquarePlus, Minimize2, RotateCcw, Send, Upload, X } from "lucide-react";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { ErrorState, ListSkeleton } from "@/components/common/states";
import { FileStatusBadge, FileKindIcon } from "@/components/projects/files/file-badges";
import { NotePin, PinColorDots, PinDraft, isPinned, lastPinColor, noteText, pinLook } from "@/components/projects/files/note-pin";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { fetchProjectFile } from "@/lib/project-queries";
import { formatBytes, type FileComment, type FileVersion, type FileVersionStatus } from "@/lib/projects";
import type { StageColor } from "@/lib/stages";
import { formatDateTime, formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { addFileComment, archiveProjectFile, resolveFileComment, setFileVersionStatus, setPinColor, signProjectFileUrl } from "@/server/actions/project-files";

// The drawing viewer (WebGL) loads only when a DWG/DXF is opened.
const CadPreview = dynamic(() => import("@/components/projects/files/cad-preview").then((m) => m.CadPreview), { ssr: false, loading: () => <ListSkeleton rows={3} /> });

const EVENT_TEXT: Record<string, string> = {
  uploaded: "uploaded", submitted: "sent for review", approved: "approved (client can see it)", changes_requested: "asked for changes",
  client_viewed: "opened", client_downloaded: "downloaded", client_approved: "approved", client_changes: "asked for changes",
  superseded: "replaced by a newer version", archived: "removed the file", restored: "restored",
};

/** One file: preview, pin notes, versions with the review flow, and its history (incl. what the client did). */
export function FileSheet({ fileId, onClose, onUploadVersion, onChanged }: {
  fileId: string | null; onClose: () => void; onUploadVersion: (fileId: string, folderId: string) => void; onChanged: () => void;
}) {
  const me = useProfile();
  const q = useLiveQuery({
    queryKey: `project-file:${me.id}:${fileId}`, fetcher: (s) => fetchProjectFile(fileId!, s), enabled: !!fileId,
    tables: ["project_files", "project_file_versions", "project_file_comments", "project_file_events"],
  });
  const [versionId, setVersionId] = useState<string | null>(null);
  const [tab, setTab] = useState<"notes" | "versions" | "history">("notes");
  const [pending, start] = useTransition();
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  // Wide: the panel takes the whole screen, preview on the left and the notes beside it.
  const [wide, setWide] = useState(false);
  // The pin being hovered (on the picture or in the list), so both light up together.
  const [activePin, setActivePin] = useState<string | null>(null);
  if (fileId !== openedFor) { setOpenedFor(fileId); setVersionId(null); setTab("notes"); setActivePin(null); }

  const d = q.data;
  const version = d?.versions.find((v) => v.id === (versionId ?? d.file.current_version_id)) ?? d?.versions[0] ?? null;
  const isDrawing = !!version && d?.file.kind === "cad" && /\.(dwg|dxf)$/i.test(version.original_name);
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => start(async () => {
    const r = await fn();
    if (!r.ok) return void toast.error(r.error ?? "Could not save");
    toast.success(done);
    q.refetch();
    onChanged();
  });
  const open = async (download: boolean) => {
    if (!version) return;
    const r = await signProjectFileUrl({ versionId: version.id, download });
    if (!r.ok) return void toast.error(r.error);
    window.open(r.data.url, "_blank", "noopener,noreferrer");
  };

  return (
    <Sheet open={!!fileId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className={cn("overflow-y-auto",
        wide ? "data-[side=right]:w-full data-[side=right]:sm:max-w-none" : "data-[side=right]:w-full data-[side=right]:sm:max-w-3xl")}>
        <Button variant="ghost" size="icon-sm" className="absolute top-3 right-11 z-10" onClick={() => setWide((w) => !w)}
          aria-label={wide ? "Back to side panel" : "Expand to full screen"} title={wide ? "Back to side panel" : "Expand to full screen"}>
          {wide ? <Minimize2 /> : <Maximize2 />}
        </Button>
        {q.error && !d ? <div className="p-4"><ErrorState message={q.error} onRetry={q.refetch} /></div> : !d || !version ? <div className="p-4"><ListSkeleton rows={5} /></div> : (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 pr-16"><FileKindIcon kind={d.file.kind} />{d.file.name}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <span>v{version.version_no} · {formatBytes(version.size_bytes)} · {version.uploaded_by ?? "—"} · {formatRelative(version.created_at)}</span>
                <FileStatusBadge status={version.status} />
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-6">
              <div className="flex flex-wrap gap-2">
                {/* A browser can't show a DWG/DXF in a tab (it would just download): Open shows it full screen here instead. */}
                {isDrawing ? (
                  <Button size="sm" variant="outline" onClick={() => setWide(true)} disabled={wide}><Maximize2 /> Open full screen</Button>
                ) : <Button size="sm" variant="outline" onClick={() => open(false)}><Eye /> Open</Button>}
                <Button size="sm" variant="outline" onClick={() => open(true)}><Download /> Download</Button>
                <Button size="sm" variant="outline" onClick={() => onUploadVersion(d.file.id, d.file.folder_id)}><Upload /> New version</Button>
                <span className="flex-1" />
                <ReviewButtons version={version} canManage={d.file.can_manage} mine={version.uploaded_by_id === me.id} pending={pending}
                  onStatus={(status, done) => act(() => setFileVersionStatus({ versionId: version.id, status }), done)} />
              </div>

              <div className={cn("space-y-4", wide && "lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-6 lg:space-y-0")}>
              {isDrawing ? (
                <CadPreview key={version.id} versionId={version.id} fileName={version.original_name} size={version.size_bytes} wide={wide} active={activePin} onActive={setActivePin}
                  comments={d.comments.filter((c) => c.version_id === version.id)} onPinned={() => { setTab("notes"); q.refetch(); onChanged(); }} />
              ) : (
                <Preview versionId={version.id} kind={d.file.kind} mime={version.mime_type} wide={wide} active={activePin} onActive={setActivePin}
                  comments={d.comments.filter((c) => c.version_id === version.id)} onPinned={() => { setTab("notes"); q.refetch(); onChanged(); }} />
              )}

              {/* Full screen: this column fills the height; the list scrolls and the note box stays at the bottom. */}
              <div className={cn("space-y-4", wide && "lg:sticky lg:top-0 lg:flex lg:h-[calc(100dvh-11rem)] lg:flex-col lg:gap-3 lg:space-y-0")}>
              <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
                <TabsList>
                  <TabsTrigger value="notes">Notes ({d.comments.filter((c) => c.version_id === version.id && !c.resolved_at).length})</TabsTrigger>
                  <TabsTrigger value="versions">Versions ({d.versions.length})</TabsTrigger>
                  <TabsTrigger value="history">History</TabsTrigger>
                </TabsList>
              </Tabs>
              {tab === "notes" ? (
                <Notes versionId={version.id} comments={d.comments.filter((c) => c.version_id === version.id)} onChanged={() => q.refetch()}
                  active={activePin} onActive={setActivePin} wide={wide} canColor={(c) => d.file.can_manage || (!!c.author_id && c.author_id === me.id)} />
              ) : tab === "versions" ? (
                <ul className={cn("divide-y rounded-lg border", wide && "lg:min-h-0 lg:flex-1 lg:overflow-y-auto")}>
                  {d.versions.map((v) => (
                    <li key={v.id}>
                      <button type="button" onClick={() => setVersionId(v.id)} className={cn("flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/30", v.id === version.id && "bg-accent/40")}>
                        <span className="font-medium tabular-nums">v{v.version_no}</span>
                        <FileStatusBadge status={v.status} />
                        <span className="text-sm text-muted-foreground">{v.uploaded_by} · {formatDateTime(v.created_at)} · {formatBytes(v.size_bytes)}</span>
                        {v.note ? <span className="w-full text-sm text-muted-foreground">“{v.note}”</span> : null}
                        {v.client_comment ? <span className="w-full text-sm text-amber-200">Client: {v.client_comment}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <ol className={cn("space-y-2 text-sm", wide && "lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1")}>
                  {d.events.map((e) => {
                    const v = d.versions.find((x) => x.id === e.version_id);
                    return (
                      <li key={e.id} className="flex gap-2">
                        <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", e.from_client ? "bg-emerald-400" : "bg-muted-foreground/50")} />
                        <span>
                          <span className="font-medium">{e.from_client ? "Client" : e.actor ?? "Someone"}</span> {EVENT_TEXT[e.type] ?? e.type}
                          {v ? ` v${v.version_no}` : ""} · <span className="text-muted-foreground">{formatDateTime(e.created_at)}</span>
                          {e.comment ? <span className="block text-muted-foreground">“{e.comment}”</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
              </div>
              </div>
              <div className="pt-2">
                <ConfirmDialog trigger={<Button variant="ghost" size="sm" className="text-red-400 hover:text-red-300"><Archive /> Remove file</Button>}
                  title={`Remove “${d.file.name}”?`} description="It disappears from the folder and the client portal. An admin can restore it." confirmLabel="Remove" destructive
                  onConfirm={async () => { const r = await archiveProjectFile({ id: d.file.id }); if (!r.ok) { toast.error(r.error); return false; } onChanged(); onClose(); }} />
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ReviewButtons({ version, canManage, mine, pending, onStatus }: {
  version: FileVersion; canManage: boolean; mine: boolean; pending: boolean; onStatus: (s: "draft" | "submitted" | "approved" | "changes_requested", done: string) => void;
}) {
  const s: FileVersionStatus = version.status;
  return (
    <div className="flex flex-wrap gap-2">
      {/* Admins and the architect manager are the reviewers: they approve straight away, no review step for themselves. */}
      {!canManage && (s === "draft" || s === "changes_requested") ? <Button size="sm" disabled={pending} onClick={() => onStatus("submitted", "Sent for review")}><Send /> Send for review</Button> : null}
      {canManage && s !== "superseded" && s !== "approved" && s !== "client_approved" ? (
        <Button size="sm" disabled={pending} className="bg-emerald-600 text-white hover:bg-emerald-500" onClick={() => onStatus("approved", "Approved — the client can see it now")}><CheckCircle2 /> Approve for client</Button>
      ) : null}
      {canManage && s === "submitted" ? <Button size="sm" variant="outline" disabled={pending} onClick={() => onStatus("changes_requested", "Changes requested")}><RotateCcw /> Ask for changes</Button> : null}
      {(canManage || mine) && (s === "approved") ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => onStatus("draft", "Hidden from the client")}><X /> Hide from client</Button> : null}
    </div>
  );
}

/**
 * Image / PDF / video preview. On images: "Pin a note", click a spot, write the note there (nothing is saved
 * without text); hover a pin to read its note. DWG/DXF open in CadPreview; SketchUp shows a card.
 */
function Preview({ versionId, kind, mime, comments, wide, active, onActive, onPinned }: {
  versionId: string; kind: string; mime: string; comments: FileComment[]; wide: boolean;
  active: string | null; onActive: (id: string | null) => void; onPinned: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [draft, setDraft] = useState<{ x: number; y: number; body: string; color: StageColor } | null>(null);
  const [pending, start] = useTransition();
  const box = useRef<HTMLDivElement>(null);
  const previewable = kind === "image" && mime !== "image/heic" || kind === "pdf" || kind === "video";
  useEffect(() => {
    let live = true;
    if (!previewable) return;
    signProjectFileUrl({ versionId, download: false }).then((r) => {
      if (!live) return;
      if (r.ok) setUrl(r.data.url); else setFailed(true);
    });
    return () => { live = false; };
  }, [versionId, previewable]);
  const tall = wide ? "max-h-[calc(100dvh-12rem)]" : "max-h-[65vh]";
  if (!previewable) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        <FileKindIcon kind={kind} className="size-8" />
        {kind === "cad" ? "No preview for this drawing type. Download to open it in AutoCAD or a free DWG viewer." : kind === "sketchup" ? "SketchUp preview is coming. Upload a PDF or image export next to it for the client." : "No preview for this type. Download to open it."}
      </div>
    );
  }
  if (failed) return <p className="text-sm text-red-300">Couldn&apos;t load the preview.</p>;
  if (!url) return <ListSkeleton rows={3} />;
  if (kind === "pdf") return <iframe title="PDF preview" src={url} className={cn("w-full rounded-lg border bg-white", wide ? "h-[calc(100dvh-12rem)]" : "h-[65vh]")} />;
  if (kind === "video") return <video src={url} controls className={cn("w-full rounded-lg border bg-black", tall)} />;
  const pins = comments.filter(isPinned);
  const save = () => draft && draft.body.trim() && start(async () => {
    const r = await addFileComment({ versionId, body: draft.body, x: draft.x, y: draft.y, color: draft.color });
    if (!r.ok) return void toast.error(r.error);
    toast.success("Note pinned");
    setDraft(null);
    onPinned();
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={pinning ? "secondary" : "outline"} onClick={() => { setPinning((p) => !p); setDraft(null); }}>
          <MessageSquarePlus /> {pinning ? "Click a spot on the picture…" : "Pin a note"}
        </Button>
        {pinning ? <Button size="sm" variant="ghost" onClick={() => setPinning(false)}>Cancel</Button> : null}
        <span className="text-xs text-muted-foreground">{pins.length ? `${pins.length} pin${pins.length === 1 ? "" : "s"} · hover one to read it` : ""}</span>
      </div>
      <div className="flex justify-center rounded-lg border bg-black/40">
        {/* Pins are placed on the picture itself (not the frame around it), so they stay put at any size. */}
        <div ref={box} className={cn("relative", pinning && "cursor-crosshair")}
          onClick={(e) => {
            if (!pinning || !box.current) return;
            const r = box.current.getBoundingClientRect();
            const pct = (v: number) => Math.min(100, Math.max(0, Math.round(v * 1000) / 10));
            setDraft({ x: pct((e.clientX - r.left) / r.width), y: pct((e.clientY - r.top) / r.height), body: "", color: lastPinColor() });
            setPinning(false);
          }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not optimisable */}
          <img src={url} alt="Preview" className={cn("block w-auto max-w-full select-none", tall)} draggable={false} />
          {pins.map((c, i) => c.x_pct != null && c.y_pct != null ? (
            <NotePin key={c.id} c={c} n={i + 1} active={active === c.id} onActive={onActive} style={{ left: `${c.x_pct}%`, top: `${c.y_pct}%` }} x={c.x_pct} y={c.y_pct} />
          ) : null)}
          {draft ? (
            <PinDraft n={pins.length + 1} style={{ left: `${draft.x}%`, top: `${draft.y}%` }} x={draft.x} y={draft.y} body={draft.body} pending={pending}
              onBody={(body) => setDraft({ ...draft, body })} color={draft.color} onColor={(color) => setDraft({ ...draft, color })}
              onSave={save} onCancel={() => setDraft(null)} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Notes({ versionId, comments, onChanged, active, onActive, wide, canColor }: {
  versionId: string; comments: FileComment[]; onChanged: () => void; active: string | null; onActive: (id: string | null) => void; wide: boolean;
  canColor: (c: FileComment) => boolean;
}) {
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const pinned = comments.filter(isPinned);
  return (
    <div className={cn("space-y-3", wide && "lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:space-y-0 lg:gap-3")}>
      <ul className={cn("space-y-2", wide && "lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1")}>
        {comments.map((c) => (
          <li key={c.id} id={`note-${c.id}`} onMouseEnter={() => isPinned(c) && onActive(c.id)} onMouseLeave={() => onActive(null)}
            className={cn("rounded-lg border p-2.5 text-sm transition-colors", c.resolved_at && "opacity-60", c.from_client && "border-emerald-400/40",
              active === c.id && "border-red-400/60 bg-red-400/[0.06]")}>
            <div className="flex items-center gap-2">
              {isPinned(c) ? (
                <PinBadge c={c} n={pinned.indexOf(c) + 1} editable={canColor(c)} onChanged={onChanged} />
              ) : null}
              <span className="font-medium">{c.from_client ? "Client" : c.author}</span>
              <span className="text-xs text-muted-foreground">{formatRelative(c.created_at)}</span>
              <span className="flex-1" />
              <Button size="xs" variant="ghost" disabled={pending} onClick={() => start(async () => {
                const r = await resolveFileComment({ id: c.id, resolved: !c.resolved_at });
                if (!r.ok) return void toast.error(r.error);
                onChanged();
              })}>{c.resolved_at ? <><RotateCcw /> Reopen</> : <><Check /> Done</>}</Button>
            </div>
            <p className={cn("mt-1 whitespace-pre-wrap break-words", c.resolved_at && "line-through", c.body.trim() === "📍" && "text-muted-foreground italic")}>{noteText(c.body)}</p>
          </li>
        ))}
        {!comments.length ? <li className="text-sm text-muted-foreground">No notes on this version.</li> : null}
      </ul>
      <form className={cn("flex gap-2", wide && "lg:shrink-0 lg:border-t lg:pt-3")} onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addFileComment({ versionId, body });
          if (!r.ok) return void toast.error(r.error);
          setBody("");
          onChanged();
        });
      }}>
        <Textarea rows={2} value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} placeholder="Note for the team, e.g. move the pergola 2 ft left" aria-label="New note" />
        <Button type="submit" disabled={pending || !body.trim()}>{pending ? <Loader2 className="animate-spin" /> : <Send />}</Button>
      </form>
    </div>
  );
}

/** The pin's number in the notes list; click it to change the pin's colour (the writer or a manager). */
function PinBadge({ c, n, editable, onChanged }: { c: FileComment; n: number; editable: boolean; onChanged: () => void }) {
  const [pending, start] = useTransition();
  const look = pinLook(c);
  const badge = (
    <span style={look.style} className={cn("flex size-5 items-center justify-center rounded-full border text-[10px] font-bold", look.className)}>{n}</span>
  );
  if (!editable) return badge;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="rounded-full focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Pin ${n} colour`} title="Change the pin's colour">{badge}</button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto space-y-1.5 p-2">
        <div className="text-xs text-muted-foreground">Pin colour</div>
        <PinColorDots value={c.pin_color ?? null} disabled={pending} onChange={(color) => start(async () => {
          const r = await setPinColor({ id: c.id, color });
          if (!r.ok) return void toast.error(r.error);
          onChanged();
        })} />
      </PopoverContent>
    </Popover>
  );
}
