"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Download,
  ExternalLink,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Info,
  LayoutGrid,
  List,
  Loader2,
  MoreHorizontal,
  Search,
  SquareCheck,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataPagination } from "@/components/common/data-pagination";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { FolderCard, FolderCards, FolderListItem, FolderNameDialog, LibraryInfoDialog, useUrlSearch } from "@/components/library/library-view";
import { ArchiveItemDialog, BackgroundContextMenu, LibraryActionsProvider, type LibraryItemActions } from "@/components/library/context-menus";
import { FolderPickerDialog, moveItems, SelectionBar } from "@/components/library/selection";
import {
  ArrangeHint,
  DropTargetLink,
  LibraryDnd,
  LibrarySortMenu,
  SortableArea,
  SortableItem,
  useLibraryArrange,
  useLibrarySelection,
  useLibrarySort,
  type LibraryDndMode,
} from "@/components/library/sorting";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { uploadLibraryFiles, useFileDrop } from "@/components/library/upload";
import { formatBytes, isImageMime, LIBRARY_ACCEPT, LIBRARY_MAX_BYTES } from "@/lib/library";
import { fetchLibraryFolder, fetchLibraryItems, signLibraryUrl, signLibraryUrls, type LibraryFile, type LibraryFolder, type LibraryItem } from "@/lib/library-queries";
import { lastPage, parsePaging } from "@/lib/pagination";
import { can } from "@/lib/permissions";
import { attachThumbnail } from "@/lib/thumbnail";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { setFileArchived } from "@/server/actions/library";

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
  const { q, input, setInput, clear } = useUrlSearch();
  const archived = isAdmin && params.get("archived") === "1";
  const { sort, foldersFirst, setSort, setFoldersFirst } = useLibrarySort();
  const query = useMemo(
    () => ({ parentId: folderId, q, archived, sort, foldersFirst, page: paging.page, pageSize: paging.pageSize }),
    [folderId, q, archived, sort, foldersFirst, paging.page, paging.pageSize],
  );

  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  const folder = useLiveQuery({ queryKey: `library-folder:${profile.id}:${folderId}`, fetcher: (s) => fetchLibraryFolder(folderId, s), tables: ["library_folders"] });
  // One sorted page of this folder's subfolders and files.
  const { data, error, isFetching, isInitialLoading, isStale, refetch } = useLiveQuery({
    queryKey: `library-items:${profile.id}:${JSON.stringify(query)}`,
    fetcher: (s) => fetchLibraryItems(query, s),
    tables: ["library_folders", "library_files"],
  });
  const arrangement = useLibraryArrange(folderId, data?.items ?? [], refetch);
  const shown = arrangement.items;
  const subItems = useMemo(() => shown.filter((i): i is LibraryFolder => i.kind === "folder"), [shown]);
  const fileItems = useMemo(() => shown.filter((i): i is LibraryFile => i.kind === "file"), [shown]);
  const [renaming, setRenaming] = useState<LibraryFolder | null>(null);
  const [archiving, setArchiving] = useState<LibraryItem | null>(null);
  const router = useRouter();
  const selection = useLibrarySelection(JSON.stringify(query));
  const [picker, setPicker] = useState<{ action: "move" | "copy"; items: LibraryItem[] } | null>(null);
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) {
      set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
    }
  }, [data, isStale, query.page, query.pageSize, set]);

  // One batched signing request for this page's previews (URLs valid 10 min, re-signed every 5).
  const previewPaths = useMemo(() => fileItems.map(previewPath).filter((p): p is string => !!p), [fileItems]);
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
    const missing = data.items.filter((f): f is LibraryFile => f.kind === "file").filter((f) => !f.thumb_path && !f.archived_at && f.size_bytes <= LIBRARY_MAX_BYTES && !tried.current.has(f.id));
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
  const [infoOpen, setInfoOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const folderArchived = !!folder.data?.archived_at;

  async function uploadFiles(picked: File[]) {
    if (!picked.length) return;
    setUploading(true);
    try {
      await uploadLibraryFiles(folderId, picked, folder.data?.name);
    } finally {
      setUploading(false);
      refetch();
    }
  }
  const canUpload = !folderArchived && !folder.isInitialLoading && !!folder.data;
  const drop = useFileDrop((f) => void uploadFiles(f), canUpload && !uploading);

  if (folder.error && !folder.data) return <ErrorState message={folder.error} onRetry={folder.refetch} />;
  if (!folder.isInitialLoading && !folder.data) {
    return (
      <EmptyState
        title="Folder not found"
        description="This folder doesn't exist or was removed."
        action={
          <Button variant="outline" asChild>
            <Link href="/library">Back to Library</Link>
          </Button>
        }
      />
    );
  }

  const crumbs = folder.data?.path ?? [];
  const sortChange = (v: Parameters<typeof setSort>[0]) => { setSort(v); set({ page: null }); };
  const filePreview = (f: LibraryFile) => {
    const p = previewPath(f);
    return { preview: p ? previews.data?.[p] : undefined, hasPreview: !!p };
  };

  // Admins: long press rearranges in custom order, otherwise (or while selecting) it moves items onto folders.
  const dndMode: LibraryDndMode = !isAdmin || archived || folderArchived ? "off" : selection.selecting || sort !== "custom" || q ? "move" : "reorder";
  const onMove = async (items: Parameters<typeof moveItems>[0], target: Parameters<typeof moveItems>[1]) => {
    if (await moveItems(items, target)) selection.clear();
    refetch();
  };

  // Right-click menus. Acting on a selected item acts on the whole selection.
  const manage = isAdmin && !folderArchived;
  const withSelection = (item: LibraryItem) => (selection.has(`${item.kind}:${item.id}`) && selection.items.length > 1 ? selection.items : [item]);
  const actions: LibraryItemActions = {
    open: (item) => (item.kind === "folder" ? router.push(`/library/${item.id}`) : void openLibraryFile(item.storage_path)),
    openInNewTab: (item) => (item.kind === "folder" ? window.open(`/library/${item.id}`, "_blank", "noopener") : void openLibraryFile(item.storage_path)),
    download: (file) => void downloadLibraryFile(file),
    ...(manage
      ? {
          rename: setRenaming,
          toggleSelect: selection.toggle,
          isSelected: (item: LibraryItem) => selection.has(`${item.kind}:${item.id}`),
          move: (item: LibraryItem) => setPicker({ action: "move", items: withSelection(item) }),
          copy: (file: LibraryFile) => {
            const items = withSelection(file);
            if (items.some((i) => i.kind === "folder")) return void toast.error("Only files can be copied. Deselect the folders first.");
            setPicker({ action: "copy", items });
          },
          archive: setArchiving,
        }
      : {}),
  };

  return (
    <div {...drop.props} className="relative min-h-[calc(100svh-8rem)] space-y-6">
      {/* Full-screen drag drop overlay */}
      {drop.over ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-white/30 bg-[#262626] p-8 text-center shadow-2xl">
            <div className="flex size-16 items-center justify-center rounded-2xl border border-white/20 bg-white/10 text-white animate-bounce">
              <Upload className="size-8" />
            </div>
            <div>
              <p className="text-lg font-semibold text-foreground">Drop files to upload</p>
              <p className="text-xs text-muted-foreground mt-1">Uploading into &ldquo;{folder.data?.name}&rdquo;</p>
            </div>
          </div>
        </div>
      ) : null}

      <LibraryDnd mode={dndMode} selection={selection} onArrange={(next) => void arrangement.arrange(next)} onMove={(items, target) => void onMove(items, target)}>
      {/* Breadcrumb Navigation Pill (items can be dropped on the Library and parent folders) */}
      <nav
        aria-label="Folder path"
        className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
      >
        <DropTargetLink target={{ id: null, name: "Library" }}>
          <Link
            href="/library"
            draggable={false}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-white/[0.06] hover:text-foreground"
          >
            <FolderOpen className="size-3.5 text-zinc-400" />
            <span>Library</span>
          </Link>
        </DropTargetLink>
        {crumbs.slice(0, -1).map((c) => (
          <Fragment key={c.id}>
            <ChevronRight className="size-3.5 text-muted-foreground/60" aria-hidden />
            <DropTargetLink target={{ id: c.id, name: c.name }}>
              <Link
                href={`/library/${c.id}`}
                draggable={false}
                className="block max-w-48 truncate rounded-md px-2 py-1 transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                {c.name}
              </Link>
            </DropTargetLink>
          </Fragment>
        ))}
        <ChevronRight className="size-3.5 text-muted-foreground/60" aria-hidden />
        <span className="truncate rounded-md bg-white/[0.05] px-2 py-1 font-medium text-foreground">
          {folder.data?.name ?? "…"}
        </span>
      </nav>

      {/* Main Folder Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2.5">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-zinc-300">
              <Folder className="size-5" />
            </div>
            {folder.isInitialLoading ? (
              <Skeleton className="h-8 w-48" />
            ) : (
              <h1 className="truncate text-xl font-bold tracking-tight text-foreground md:text-2xl">
                {folder.data?.name}
              </h1>
            )}
            {folderArchived ? (
              <Badge variant="outline" className="border-white/15 text-zinc-400 bg-white/[0.05] text-xs">
                Archived
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground pl-12.5">
            {folderArchived
              ? "This folder is archived. Restore it to add files or share."
              : "Drag & drop files anywhere, or use the buttons to add folders and assets."}
          </p>
        </div>

        {!folderArchived ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInfoOpen(true)}
              className="size-8.5 rounded-lg border-white/[0.1] bg-[#262626]/60 p-0 text-muted-foreground hover:bg-[#2c2c2c] hover:text-foreground"
              aria-label="Library details and specifications"
              title="Library details and specifications"
            >
              <Info className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreating(true)}
              disabled={folder.isInitialLoading}
              className="gap-2 text-xs"
            >
              <FolderPlus className="size-3.5" /> New subfolder
            </Button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={LIBRARY_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                void uploadFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <Button
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={uploading || folder.isInitialLoading}
              className="gap-2 text-xs font-medium shadow-sm"
            >
              {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              Upload files
            </Button>
          </div>
        ) : null}
      </div>

      {/* Toolbar & Controls */}
      <div className="flex flex-col gap-3 rounded-xl border border-white/[0.08] bg-[#262626]/40 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2.5">
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9 pr-8 bg-[#1f1f1f]/80 border-white/[0.1] focus:border-white/25 h-9 text-sm"
              placeholder="Search in this folder…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="Search this folder"
            />
            {input ? (
              <button
                type="button"
                onClick={clear}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:bg-white/10 hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>

          {isAdmin ? (
            <div
              className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-[#1f1f1f]/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={() => set({ archived: archived ? null : "1" })}
            >
              <Checkbox
                checked={archived}
                onCheckedChange={(c) => set({ archived: c === true ? "1" : null })}
                id="folder-archived-filter"
              />
              <Label htmlFor="folder-archived-filter" className="cursor-pointer text-xs font-normal">
                Show archived
              </Label>
            </div>
          ) : null}

          <FetchingIndicator show={isFetching && !isInitialLoading} />
        </div>

        <div className="flex items-center justify-between gap-2 sm:justify-end">
        {isAdmin && !archived && !folderArchived ? (
          <Button
            variant={selection.selecting ? "secondary" : "outline"}
            size="sm"
            className="h-8.5 gap-1.5 text-xs"
            onClick={() => selection.setSelecting(!selection.selecting)}
            aria-pressed={selection.selecting}
          >
            <SquareCheck className="size-3.5" /> Select
          </Button>
        ) : null}
        <LibrarySortMenu
          sort={sort}
          foldersFirst={foldersFirst}
          onSort={sortChange}
          onFoldersFirst={(on) => { setFoldersFirst(on); set({ page: null }); }}
        />

        {/* View Mode Toggle */}
        <div className="flex items-center rounded-lg border border-white/[0.08] bg-[#1a1a1a] p-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "size-7.5 rounded-md text-muted-foreground hover:text-foreground",
              viewMode === "grid" && "bg-white/15 text-white shadow-xs",
            )}
            onClick={() => setViewMode("grid")}
            aria-label="Grid view"
            title="Grid view"
          >
            <LayoutGrid className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "size-7.5 rounded-md text-muted-foreground hover:text-foreground",
              viewMode === "list" && "bg-white/15 text-white shadow-xs",
            )}
            onClick={() => setViewMode("list")}
            aria-label="List view"
            title="List view"
          >
            <List className="size-3.5" />
          </Button>
        </div>
        </div>
      </div>

      {/* Right-click the empty space for the page menu, or an item for its menu. */}
      <LibraryActionsProvider value={actions}>
      <BackgroundContextMenu
        className="min-h-[40vh]"
        newFolderLabel="New subfolder"
        onNewFolder={folderArchived ? undefined : () => setCreating(true)}
        onUpload={folderArchived ? undefined : () => inputRef.current?.click()}
        onSelect={manage && !archived ? () => selection.setSelecting(!selection.selecting) : undefined}
        selecting={selection.selecting}
        sort={sort}
        onSort={sortChange}
        foldersFirst={foldersFirst}
        onFoldersFirst={(on) => { setFoldersFirst(on); set({ page: null }); }}
        viewMode={viewMode}
        onViewMode={setViewMode}
        archived={archived}
        onArchived={isAdmin ? (on) => set({ archived: on ? "1" : null }) : undefined}
        onRefresh={refetch}
      >
      {error && !data ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : isInitialLoading ? (
        <ListSkeleton rows={4} />
      ) : !data?.total ? (
        <EmptyState
          title={archived ? "Nothing archived in this folder" : q ? "Nothing matches your search" : "This folder is empty"}
          description={
            archived || q || folderArchived
              ? undefined
              : "Upload brochures, price lists, or project images to start sharing with customers."
          }
          action={
            !archived && !q && !folderArchived ? (
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => inputRef.current?.click()} className="gap-2 text-xs">
                  <Upload className="size-3.5" /> Upload files
                </Button>
                <Button size="sm" variant="outline" onClick={() => setCreating(true)} className="gap-2 text-xs">
                  <FolderPlus className="size-3.5" /> New subfolder
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <div className={cn("space-y-6", isStale && "opacity-60")}>
          <ArrangeHint mode={dndMode} selecting={selection.selecting} sort={sort} />

          {foldersFirst ? (
            <>
              {subItems.length ? (
                <section aria-label="Subfolders" className="space-y-2.5">
                  <h2 className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">Subfolders</h2>
                  <FolderCards
                    folders={subItems}
                    isAdmin={isAdmin}
                    onChanged={refetch}
                    viewMode={viewMode}
                  />
                </section>
              ) : null}

              {fileItems.length ? (
                <section className="space-y-3" aria-label="Files">
                  <h2 className="text-xs font-semibold tracking-wider uppercase text-muted-foreground">Files</h2>
                  <SortableArea items={fileItems} layout={viewMode}>
                    {viewMode === "grid" ? (
                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                        {fileItems.map((f) => (
                          <SortableItem key={f.id} item={f} className="flex">
                            <FileCard file={f} {...filePreview(f)} isAdmin={isAdmin} onDone={refetch} />
                          </SortableItem>
                        ))}
                      </div>
                    ) : (
                      <ListFrame label="File Name">
                        {fileItems.map((f) => (
                          <SortableItem key={f.id} item={f}>
                            <FileListItem file={f} isAdmin={isAdmin} onDone={refetch} />
                          </SortableItem>
                        ))}
                      </ListFrame>
                    )}
                  </SortableArea>
                </section>
              ) : null}
            </>
          ) : (
            // Folders and files mixed in one sorted list.
            <section aria-label="Folders and files">
              <SortableArea items={shown} layout={viewMode}>
                {viewMode === "grid" ? (
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                    {shown.map((i) => (
                      <SortableItem key={i.id} item={i} className="flex">
                        {i.kind === "folder" ? (
                          <FolderCard folder={i} isAdmin={isAdmin} onRename={() => setRenaming(i)} onChanged={refetch} />
                        ) : (
                          <FileCard file={i} {...filePreview(i)} isAdmin={isAdmin} onDone={refetch} />
                        )}
                      </SortableItem>
                    ))}
                  </div>
                ) : (
                  <ListFrame label="Name">
                    {shown.map((i) => (
                      <SortableItem key={i.id} item={i}>
                        {i.kind === "folder" ? (
                          <FolderListItem folder={i} isAdmin={isAdmin} onRename={() => setRenaming(i)} onChanged={refetch} />
                        ) : (
                          <FileListItem file={i} isAdmin={isAdmin} onDone={refetch} />
                        )}
                      </SortableItem>
                    ))}
                  </ListFrame>
                )}
              </SortableArea>
            </section>
          )}

          <DataPagination
            page={query.page}
            pageSize={query.pageSize}
            total={data.total}
            disabled={isFetching}
            onPageChange={(p) => set({ page: String(p) })}
            onPageSizeChange={(s) => set({ pageSize: String(s) })}
          />
        </div>
      )}
      </BackgroundContextMenu>
      </LibraryActionsProvider>
      </LibraryDnd>

      <SelectionBar selection={selection} pageItems={shown} onPick={(action) => setPicker({ action, items: selection.items })} />
      <ArchiveItemDialog item={archiving} onClose={() => setArchiving(null)} onDone={refetch} />
      <FolderPickerDialog
        action={picker?.action ?? null}
        items={picker?.items ?? []}
        currentFolderId={folderId}
        onClose={() => setPicker(null)}
        onDone={() => { selection.clear(); refetch(); }}
      />

      <FolderNameDialog
        open={!!renaming}
        folder={renaming}
        parentId={folderId}
        onOpenChange={(o) => !o && setRenaming(null)}
        onDone={refetch}
      />

      {/* New subfolder dialog */}
      <FolderNameDialog
        open={creating}
        parentId={folderId}
        onOpenChange={setCreating}
        onDone={refetch}
      />

      <LibraryInfoDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        totalFiles={data?.total}
      />
    </div>
  );
}

/** Table frame for list view (folder and file rows share its columns). */
function ListFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#262626]/40">
      <div className="grid grid-cols-12 gap-3 border-b border-white/[0.08] px-4 py-2.5 text-xs font-medium text-muted-foreground">
        <div className="col-span-6 sm:col-span-5">{label}</div>
        <div className="col-span-3 sm:col-span-3">Details</div>
        <div className="hidden sm:col-span-3 sm:block">Added</div>
        <div className="col-span-3 sm:col-span-1 text-right">Actions</div>
      </div>
      <div className="divide-y divide-white/[0.06]">{children}</div>
    </div>
  );
}

/** Grid view card for files */
function FileCard({
  file,
  preview,
  hasPreview,
  isAdmin,
  onDone,
}: {
  file: LibraryFile;
  preview?: string;
  hasPreview: boolean;
  isAdmin: boolean;
  onDone: () => void;
}) {
  const archived = !!file.archived_at;
  const pdf = file.mime_type === "application/pdf";

  // Same shape as the folder card: preview on the left, name in the middle, actions on the right.
  return (
    <div
      className={cn(
        "group relative flex w-full flex-row items-center justify-between gap-3 overflow-hidden rounded-xl border border-white/[0.08] bg-[#262626] px-3 py-2 sm:px-3.5 sm:py-2.5 shadow-xs transition-all duration-200",
        "hover:border-white/20 hover:bg-[#2c2c2c] hover:shadow-md",
        archived && "opacity-75 border-dashed",
      )}
    >
      {/* Left: small preview, or a PDF / image icon */}
      <div
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border",
          pdf ? "border-red-500/25 bg-red-500/10 text-red-400" : "border-sky-500/25 bg-sky-500/10 text-sky-400",
        )}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" loading="lazy" draggable={false} className={cn("size-full object-cover", pdf ? "object-top" : "object-center")} />
        ) : hasPreview ? (
          <span className="size-full animate-pulse bg-white/[0.05]" />
        ) : pdf ? (
          <FileText className="size-4" />
        ) : (
          <FileImage className="size-4" />
        )}
      </div>

      {/* Middle: name (the whole card opens the file) and details */}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => void openLibraryFile(file.storage_path)}
          className="block w-full min-w-0 text-left after:absolute after:inset-0 focus-visible:outline-none"
          aria-label={`Open ${file.name}`}
        >
          <span className="block truncate text-xs sm:text-sm font-medium leading-tight text-zinc-200 transition-colors group-hover:text-white" title={file.name}>
            {file.name}
          </span>
        </button>
        <p className="mt-0.5 truncate text-[11px] leading-none text-zinc-400">
          {pdf ? "PDF" : "Image"} · {formatBytes(file.size_bytes)} · {formatDate(file.created_at)}
        </p>
      </div>

      {/* Right: actions */}
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        {archived ? (
          <Badge variant="outline" className="border-white/[0.1] bg-white/[0.04] text-[10px] text-zinc-400">
            Archived
          </Badge>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground hover:text-foreground hover:bg-white/10"
              aria-label={`Actions for ${file.name}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={() => void openLibraryFile(file.storage_path)} className="gap-2 text-xs">
              <ExternalLink className="size-3.5" /> Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void downloadLibraryFile(file)} className="gap-2 text-xs">
              <Download className="size-3.5" /> Download
            </DropdownMenuItem>
            {isAdmin ? (
              <ConfirmDialog
                trigger={
                  <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="gap-2 text-xs">
                    {archived ? (
                      <>
                        <ArchiveRestore className="size-3.5" /> Restore
                      </>
                    ) : (
                      <>
                        <Archive className="size-3.5" /> Archive
                      </>
                    )}
                  </DropdownMenuItem>
                }
                title={archived ? `Restore "${file.name}"?` : `Archive "${file.name}"?`}
                description={
                  archived
                    ? "It can be shared again and reopens from existing links."
                    : "It disappears from the library and stops opening from existing share links. You can restore it later."
                }
                confirmLabel={archived ? "Restore" : "Archive"}
                destructive={!archived}
                onConfirm={async () => {
                  const r = await setFileArchived({ id: file.id, archived: !archived });
                  if (!r.ok) {
                    toast.error(r.error);
                    return false;
                  }
                  toast.success(archived ? `${file.name} restored` : `${file.name} archived`);
                  onDone();
                }}
              />
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** List view row for files */
function FileListItem({
  file,
  isAdmin,
  onDone,
}: {
  file: LibraryFile;
  isAdmin: boolean;
  onDone: () => void;
}) {
  const archived = !!file.archived_at;
  const pdf = file.mime_type === "application/pdf";

  return (
    <div className="grid grid-cols-12 items-center gap-3 px-4 py-2.5 text-xs transition-colors hover:bg-white/[0.04]">
      <div className="col-span-6 sm:col-span-5 flex items-center gap-2.5 min-w-0">
        <div
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg border",
            pdf
              ? "border-red-500/25 bg-red-500/10 text-red-400"
              : "border-sky-500/25 bg-sky-500/10 text-sky-400",
          )}
        >
          {pdf ? <FileText className="size-3.5" /> : <FileImage className="size-3.5" />}
        </div>
        <button
          type="button"
          onClick={() => void openLibraryFile(file.storage_path)}
          className="truncate font-medium text-foreground hover:text-white text-left focus:outline-none"
          title={file.name}
        >
          {file.name}
        </button>
      </div>

      <div className="col-span-3 sm:col-span-3 flex items-center gap-2 text-muted-foreground">
        <span>{formatBytes(file.size_bytes)}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] bg-white/[0.04] text-muted-foreground uppercase">
          {pdf ? "pdf" : "image"}
        </Badge>
      </div>

      <div className="hidden sm:col-span-3 sm:block text-muted-foreground">
        {formatDate(file.created_at)}
      </div>

      <div className="col-span-3 sm:col-span-1 flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={() => void downloadLibraryFile(file)}
          title="Download"
        >
          <Download className="size-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground hover:text-foreground"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onSelect={() => void openLibraryFile(file.storage_path)} className="gap-2 text-xs">
              <ExternalLink className="size-3.5" /> Open
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void downloadLibraryFile(file)} className="gap-2 text-xs">
              <Download className="size-3.5" /> Download
            </DropdownMenuItem>
            {isAdmin ? (
              <ConfirmDialog
                trigger={
                  <DropdownMenuItem onSelect={(e) => e.preventDefault()} className="gap-2 text-xs">
                    {archived ? (
                      <>
                        <ArchiveRestore className="size-3.5" /> Restore
                      </>
                    ) : (
                      <>
                        <Archive className="size-3.5" /> Archive
                      </>
                    )}
                  </DropdownMenuItem>
                }
                title={archived ? `Restore "${file.name}"?` : `Archive "${file.name}"?`}
                description={
                  archived
                    ? "It can be shared again and reopens from existing links."
                    : "It disappears from the library and stops opening from existing share links. You can restore it later."
                }
                confirmLabel={archived ? "Restore" : "Archive"}
                destructive={!archived}
                onConfirm={async () => {
                  const r = await setFileArchived({ id: file.id, archived: !archived });
                  if (!r.ok) {
                    toast.error(r.error);
                    return false;
                  }
                  toast.success(archived ? `${file.name} restored` : `${file.name} archived`);
                  onDone();
                }}
              />
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
