"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, ChevronRight, Download, ExternalLink, FileText, FolderPlus, Loader2, MoreHorizontal, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataPagination } from "@/components/common/data-pagination";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { FolderCards, FolderNameDialog, useUrlSearch } from "@/components/library/library-view";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { formatBytes, isImageMime, isLibraryMime, LIBRARY_ACCEPT, LIBRARY_BUCKET, LIBRARY_MAX_BYTES, LIBRARY_MIME_TYPES } from "@/lib/library";
import { fetchLibraryFiles, fetchLibraryFolder, fetchLibraryFolders, signLibraryUrl, signLibraryUrls, type LibraryFile } from "@/lib/library-queries";
import { lastPage, parsePaging } from "@/lib/pagination";
import { can } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/client";
import { attachThumbnail } from "@/lib/thumbnail";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { registerLibraryFile, setFileArchived } from "@/server/actions/library";

const SUBFOLDER_LIMIT = 100;

/** Opens a freshly signed URL. The tab is opened synchronously so popup blockers allow it. */
export async function openLibraryFile(path: string) {
  const win = window.open("", "_blank");
  if (win) win.opener = null;
  try {
    const url = await signLibraryUrl(path);
    if (win) win.location.href = url;
    else window.location.href = url;
  } catch {
    win?.close();
    toast.error("Couldn't open the file. Please retry.");
  }
}

async function downloadLibraryFile(file: Pick<LibraryFile, "storage_path" | "name">) {
  try {
    window.location.href = await signLibraryUrl(file.storage_path, { download: file.name });
  } catch {
    toast.error("Couldn't download the file. Please retry.");
  }
}

/** Path of the preview to show: the stored thumbnail, else the image itself; PDFs without one show an icon. */
export const previewPath = (f: Pick<LibraryFile, "thumb_path" | "storage_path" | "mime_type">) =>
  f.thumb_path ?? (isImageMime(f.mime_type) ? f.storage_path : null);

export function FolderView({ folderId }: { folderId: string }) {
  const profile = useProfile();
  const isAdmin = can.manageLibrary(profile.role);
  const { params, set } = useUrlState();
  const paging = parsePaging(params);
  const { q, input, setInput } = useUrlSearch();
  const archived = isAdmin && params.get("archived") === "1";
  const query = useMemo(() => ({ folderId, q, archived, page: paging.page, pageSize: paging.pageSize }), [folderId, q, archived, paging.page, paging.pageSize]);
  const subQuery = useMemo(() => ({ parentId: folderId, q, archived, page: 1, pageSize: SUBFOLDER_LIMIT }), [folderId, q, archived]);

  const folder = useLiveQuery({ queryKey: `library-folder:${profile.id}:${folderId}`, fetcher: (s) => fetchLibraryFolder(folderId, s), tables: ["library_folders"] });
  const subfolders = useLiveQuery({
    queryKey: `library-subfolders:${profile.id}:${JSON.stringify(subQuery)}`,
    fetcher: (s) => fetchLibraryFolders(subQuery, s),
    tables: ["library_folders", "library_files"],
  });
  const files = useLiveQuery({
    queryKey: `library-files:${profile.id}:${JSON.stringify(query)}`,
    fetcher: (s) => fetchLibraryFiles(query, s),
    tables: ["library_files"],
  });
  const { data, error, isFetching, isInitialLoading, isStale, refetch } = files;
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
  }, [data, isStale, query.page, query.pageSize, set]);

  // One batched signing request for this page's previews (URLs valid 10 min, re-signed every 5).
  const previewPaths = useMemo(() => (data?.items ?? []).map(previewPath).filter((p): p is string => !!p), [data]);
  const previews = useLiveQuery({
    queryKey: `library-previews:${previewPaths.join("|")}`,
    fetcher: () => signLibraryUrls(previewPaths),
    enabled: previewPaths.length > 0,
    pollMs: 300_000,
  });

  // Files uploaded before previews existed: make their previews in the background, once per page view.
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!data || isStale) return;
    const missing = data.items.filter((f) => !f.thumb_path && !f.archived_at && f.size_bytes <= LIBRARY_MAX_BYTES && !tried.current.has(f.id));
    if (!missing.length) return;
    let cancelled = false;
    void (async () => {
      let made = 0;
      for (const f of missing) {
        if (cancelled) return;
        tried.current.add(f.id);
        try {
          const res = await fetch(await signLibraryUrl(f.storage_path));
          if (res.ok && (await attachThumbnail(f, await res.blob()))) made++;
        } catch {
          // Leave the icon; it is retried on the next visit.
        }
      }
      if (made && !cancelled) refetch();
    })();
    return () => { cancelled = true; };
  }, [data, isStale, refetch]);

  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderArchived = !!folder.data?.archived_at;

  async function uploadFiles(list: FileList | null) {
    if (!list?.length) return;
    const picked = Array.from(list);
    const label = (i: number) => (picked.length === 1 ? `Uploading ${picked[0].name}…` : `Uploading ${i + 1} of ${picked.length}…`);
    const toastId = toast.loading(label(0));
    setUploading(true);
    const storage = createClient().storage.from(LIBRARY_BUCKET);
    const failed: string[] = [];

    for (const [i, file] of picked.entries()) {
      toast.loading(label(i), { id: toastId });
      if (!isLibraryMime(file.type)) { failed.push(`${file.name}: only PDF, PNG, JPEG or WEBP`); continue; }
      if (file.size > LIBRARY_MAX_BYTES) { failed.push(`${file.name}: larger than 25 MB`); continue; }
      if (file.size === 0) { failed.push(`${file.name}: empty file`); continue; }
      const path = `${folderId}/${crypto.randomUUID()}.${LIBRARY_MIME_TYPES[file.type]}`;
      const { error: upError } = await storage.upload(path, file, { contentType: file.type, upsert: false });
      if (upError) { failed.push(`${file.name}: upload failed`); continue; }
      const r = await registerLibraryFile({ folderId, name: file.name.slice(0, 200), storagePath: path });
      if (!r.ok) { failed.push(`${file.name}: ${r.error}`); continue; }
      await attachThumbnail({ id: r.data.id, folder_id: folderId, mime_type: file.type }, file);
    }

    setUploading(false);
    const ok = picked.length - failed.length;
    if (!failed.length) toast.success(ok === 1 ? `${picked[0].name} uploaded` : `${ok} files uploaded`, { id: toastId });
    else toast.error(ok ? `${ok} uploaded, ${failed.length} failed` : failed.length === 1 ? "Upload failed" : `${failed.length} uploads failed`, { id: toastId, description: failed.join("\n"), duration: 10_000 });
    refetch();
  }

  if (folder.error && !folder.data) return <ErrorState message={folder.error} onRetry={folder.refetch} />;
  if (!folder.isInitialLoading && !folder.data) {
    return <EmptyState title="Folder not available" description="It doesn't exist or was removed." action={<Button variant="outline" asChild><Link href="/library">Back to Library</Link></Button>} />;
  }
  const crumbs = folder.data?.path ?? [];
  const subItems = subfolders.data?.items ?? [];

  return (
    <>
      <nav aria-label="Folder path" className="mb-3 flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
        <Link href="/library" className="hover:text-foreground">Library</Link>
        {crumbs.slice(0, -1).map((c) => (
          <Fragment key={c.id}>
            <ChevronRight className="size-3.5" aria-hidden />
            <Link href={`/library/${c.id}`} className="max-w-48 truncate hover:text-foreground">{c.name}</Link>
          </Fragment>
        ))}
      </nav>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          {folder.isInitialLoading ? <Skeleton className="h-8 w-48" /> : <h1 className="truncate text-xl font-semibold tracking-tight md:text-2xl">{folder.data?.name}</h1>}
          <p className="mt-1 text-sm text-muted-foreground">{folderArchived ? "This folder is archived. Restore it to add files." : "PDF, PNG, JPEG or WEBP · up to 25 MB each"}</p>
        </div>
        {!folderArchived ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setCreating(true)} disabled={folder.isInitialLoading}><FolderPlus /> New folder</Button>
            <input ref={inputRef} type="file" multiple accept={LIBRARY_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden
              onChange={(e) => { void uploadFiles(e.target.files); e.target.value = ""; }} />
            <Button onClick={() => inputRef.current?.click()} disabled={uploading || folder.isInitialLoading}>
              {uploading ? <Loader2 className="animate-spin" /> : <Upload />} Upload files
            </Button>
          </div>
        ) : null}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search this folder" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Search this folder" />
        </div>
        {isAdmin ? (
          <Label className="flex items-center gap-2 font-normal"><Checkbox checked={archived} onCheckedChange={(c) => set({ archived: c === true ? "1" : null })} /> Archived</Label>
        ) : null}
        <FetchingIndicator show={(isFetching && !isInitialLoading) || (subfolders.isFetching && !subfolders.isInitialLoading)} />
      </div>

      {subItems.length ? (
        <section className="mb-6" aria-label="Folders">
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">Folders</h2>
          <FolderCards folders={subItems} isAdmin={isAdmin} onChanged={subfolders.refetch} />
          {(subfolders.data?.total ?? 0) > SUBFOLDER_LIMIT ? (
            <p className="mt-2 text-xs text-muted-foreground">Showing the first {SUBFOLDER_LIMIT} folders. Search to find others.</p>
          ) : null}
        </section>
      ) : null}

      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : isInitialLoading ? <ListSkeleton /> : !data?.total ? (
        subItems.length ? null : (
          <EmptyState
            title={archived ? "Nothing archived here" : q ? "Nothing matches" : "This folder is empty"}
            description={archived || q || folderArchived ? undefined : "Upload brochures, price lists or photos, or add a subfolder."}
          />
        )
      ) : (
        <section className={cn(isStale && "opacity-60")} aria-label="Files">
          {subItems.length ? <h2 className="mb-2 text-sm font-medium text-muted-foreground">Files</h2> : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {data.items.map((f) => {
              const p = previewPath(f);
              return <FileCard key={f.id} file={f} preview={p ? previews.data?.[p] : undefined} hasPreview={!!p} isAdmin={isAdmin} onDone={refetch} />;
            })}
          </div>
          <DataPagination page={query.page} pageSize={query.pageSize} total={data.total} disabled={isFetching}
            onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s) })} />
        </section>
      )}
      <FolderNameDialog open={creating} parentId={folderId} onOpenChange={setCreating} onDone={subfolders.refetch} />
    </>
  );
}

function FileCard({ file, preview, hasPreview, isAdmin, onDone }: { file: LibraryFile; preview?: string; hasPreview: boolean; isAdmin: boolean; onDone: () => void }) {
  const archived = !!file.archived_at;
  const pdf = file.mime_type === "application/pdf";
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <button type="button" onClick={() => void openLibraryFile(file.storage_path)} className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-muted/40" aria-label={`Open ${file.name}`}>
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
          <img src={preview} alt="" loading="lazy" className={cn("size-full", pdf ? "object-cover object-top" : "object-cover")} />
        ) : hasPreview ? (
          <span className="size-full animate-pulse bg-muted" />
        ) : (
          <span className="flex flex-col items-center gap-1 text-muted-foreground"><FileText className="size-10" /><span className="text-xs font-semibold tracking-wide">PDF</span></span>
        )}
        {pdf && preview ? <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white">PDF</span> : null}
      </button>
      <div className="flex items-start gap-1 p-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={file.name}>{file.name}</p>
          <p className="truncate text-xs text-muted-foreground">{formatBytes(file.size_bytes)} · {formatDate(file.created_at)}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${file.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void openLibraryFile(file.storage_path)}><ExternalLink /> Open</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void downloadLibraryFile(file)}><Download /> Download</DropdownMenuItem>
            {isAdmin ? (
              <ConfirmDialog
                trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}>{archived ? <><ArchiveRestore /> Restore</> : <><Archive /> Archive</>}</DropdownMenuItem>}
                title={archived ? `Restore "${file.name}"?` : `Archive "${file.name}"?`}
                description={archived ? "It can be shared again and reopens from existing links." : "It disappears from the library and stops opening from existing share links. You can restore it later."}
                confirmLabel={archived ? "Restore" : "Archive"}
                destructive={!archived}
                onConfirm={async () => {
                  const r = await setFileArchived({ id: file.id, archived: !archived });
                  if (!r.ok) { toast.error(r.error); return false; }
                  toast.success(archived ? `${file.name} restored` : `${file.name} archived`);
                  onDone();
                }}
              />
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
}
