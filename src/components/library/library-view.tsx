"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Info,
  LayoutGrid,
  List,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  Share2,
  SquareCheck,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataPagination } from "@/components/common/data-pagination";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { ArchiveItemDialog, BackgroundContextMenu, LibraryActionsProvider, type LibraryItemActions } from "@/components/library/context-menus";
import { FolderPickerDialog, moveItems, SelectionBar } from "@/components/library/selection";
import {
  ArrangeHint,
  LibraryDnd,
  LibrarySortMenu,
  SortableArea,
  SortableItem,
  useLibraryArrange,
  useLibrarySelection,
  useLibrarySort,
  type LibraryDndMode,
} from "@/components/library/sorting";
import { uploadLibraryFiles, useFileDrop } from "@/components/library/upload";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { formatCount } from "@/lib/format";
import { fetchLibraryItems, type LibraryFolder, type LibraryItem } from "@/lib/library-queries";
import { lastPage, parsePaging } from "@/lib/pagination";
import { can } from "@/lib/permissions";
import { cleanSearch } from "@/lib/search";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { createFolder, renameFolder, setFolderArchived } from "@/server/actions/library";

/** Search box bound to the `q` URL param (300 ms debounce). */
export function useUrlSearch() {
  const { params, set } = useUrlState();
  const q = cleanSearch(params.get("q"));
  const [input, setInput] = useState(q);
  const debounced = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debounced !== q) set({ q: debounced }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  return { q, input, setInput, clear: () => setInput("") };
}

export function LibraryView() {
  const profile = useProfile();
  const isAdmin = can.manageLibrary(profile.role);
  const { params, set } = useUrlState();
  const paging = parsePaging(params);
  const { q, input, setInput, clear } = useUrlSearch();
  const archived = isAdmin && params.get("archived") === "1";
  const { sort, setSort } = useLibrarySort();
  const query = useMemo(
    () => ({ parentId: null, q, archived, sort, foldersFirst: true, page: paging.page, pageSize: paging.pageSize }),
    [q, archived, sort, paging.page, paging.pageSize],
  );

  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [isWindowDragging, setIsWindowDragging] = useState(false);

  // Detect when files are dragged into the window to give visual feedback to the user
  useEffect(() => {
    let counter = 0;
    const onDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        counter++;
        setIsWindowDragging(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        counter--;
        if (counter <= 0) {
          counter = 0;
          setIsWindowDragging(false);
        }
      }
    };
    const onDrop = () => {
      counter = 0;
      setIsWindowDragging(false);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const { data, error, isFetching, isInitialLoading, isStale, refetch } = useLiveQuery({
    queryKey: `library-folders:${profile.id}:${JSON.stringify(query)}`,
    fetcher: (s) => fetchLibraryItems(query, s),
    tables: ["library_folders", "library_files"],
  });

  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) {
      set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
    }
  }, [data, isStale, query.page, query.pageSize, set]);

  const [creating, setCreating] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  // The top level holds folders only.
  const arrangement = useLibraryArrange(null, data?.items ?? [], refetch);
  const folders = arrangement.items as LibraryFolder[];
  const selection = useLibrarySelection(JSON.stringify(query));
  const [picker, setPicker] = useState<{ action: "move" | "copy"; items: LibraryItem[] } | null>(null);
  // Admins: long press rearranges in custom order, otherwise (or while selecting) it moves items onto folders.
  const dndMode: LibraryDndMode = !isAdmin || archived ? "off" : selection.selecting || sort !== "custom" || q ? "move" : "reorder";

  // Right-click menus.
  const router = useRouter();
  const [renaming, setRenaming] = useState<LibraryFolder | null>(null);
  const [archiving, setArchiving] = useState<LibraryItem | null>(null);
  // Acting on a selected item acts on the whole selection.
  const withSelection = (item: LibraryItem) => (selection.has(`${item.kind}:${item.id}`) && selection.items.length > 1 ? selection.items : [item]);
  const actions: LibraryItemActions = {
    open: (item) => router.push(`/library/${item.id}`),
    openInNewTab: (item) => window.open(`/library/${item.id}`, "_blank", "noopener"),
    ...(isAdmin
      ? {
          rename: setRenaming,
          toggleSelect: selection.toggle,
          isSelected: (item) => selection.has(`${item.kind}:${item.id}`),
          move: (item) => setPicker({ action: "move", items: withSelection(item) }),
          archive: setArchiving,
        }
      : {}),
  };

  const totalFilesOnPage = folders.reduce((sum, f) => sum + f.file_count, 0);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title="Library"
        description="Brochures, price lists and photos to share with customers. PDF, PNG, JPEG or WEBP, up to 25 MB each."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setInfoOpen(true)}
              className="size-9 rounded-lg border-white/[0.1] bg-[#262626]/60 text-muted-foreground hover:bg-[#2c2c2c] hover:text-foreground"
              aria-label="Library details and specifications"
              title="Library details and specifications"
            >
              <Info className="size-4" />
            </Button>
            <Button onClick={() => setCreating(true)} className="gap-2 shadow-sm font-medium">
              <FolderPlus className="size-4" />
              New folder
            </Button>
          </div>
        }
      />

      {/* Floating Drag-over notification hint */}
      {isWindowDragging ? (
        <div className="animate-in fade-in slide-in-from-top-2 flex items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-xs font-medium text-zinc-300">
          <Sparkles className="size-4 animate-pulse text-zinc-300" />
          Drop files directly onto a folder card below to upload them into that folder
        </div>
      ) : null}

      {/* Controls & Search Toolbar */}
      <div className="flex flex-col gap-3 rounded-xl border border-white/[0.08] bg-[#262626]/40 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2.5">
          {/* Search Bar */}
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9 pr-8 bg-[#1f1f1f]/80 border-white/[0.1] focus:border-white/25 focus:ring-1 focus:ring-white/20 h-9 text-sm"
              placeholder="Search folders by name…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="Search folders"
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

          {/* Archived Filter (Admin) */}
          {isAdmin ? (
            <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-[#1f1f1f]/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer" onClick={() => set({ archived: archived ? null : "1" })}>
              <Checkbox
                checked={archived}
                onCheckedChange={(c) => set({ archived: c === true ? "1" : null })}
                id="archived-filter"
              />
              <Label htmlFor="archived-filter" className="cursor-pointer text-xs font-normal">
                Show archived
              </Label>
            </div>
          ) : null}

          <FetchingIndicator show={isFetching && !isInitialLoading} />
        </div>

        {/* View Switcher & Sorting */}
        <div className="flex items-center justify-between gap-2 sm:justify-end">
          {isAdmin && !archived ? (
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
          <LibrarySortMenu sort={sort} foldersFirst onSort={(v) => { setSort(v); set({ page: null }); }} showFoldersFirst={false} />

          {/* Grid vs List View toggle */}
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

      {/* Main Content Area (right-click for the page menu, or on a folder for its menu) */}
      <LibraryActionsProvider value={actions}>
      <BackgroundContextMenu
        className="min-h-[50vh]"
        newFolderLabel="New folder"
        onNewFolder={() => setCreating(true)}
        onSelect={isAdmin && !archived ? () => selection.setSelecting(!selection.selecting) : undefined}
        selecting={selection.selecting}
        sort={sort}
        onSort={(v) => { setSort(v); set({ page: null }); }}
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
          title={archived ? "No archived folders" : q ? "No folders match your search" : "No folders created yet"}
          description={
            archived || q
              ? "Try adjusting your search filters or check your spelling."
              : "Create a folder for brochures, project specs, or customer price lists to start uploading files."
          }
          action={
            !archived && !q ? (
              <Button onClick={() => setCreating(true)} className="gap-2">
                <FolderPlus className="size-4" /> Create first folder
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className={cn("space-y-4", isStale && "opacity-60")}>
          <ArrangeHint mode={dndMode} selecting={selection.selecting} sort={sort} />
          <LibraryDnd
            mode={dndMode}
            selection={selection}
            onArrange={(next) => void arrangement.arrange(next)}
            onMove={async (items, target) => { if (await moveItems(items, target)) selection.clear(); refetch(); }}
          >
            <FolderCards folders={folders} isAdmin={isAdmin} onChanged={refetch} viewMode={viewMode} />
          </LibraryDnd>
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

      {/* Create / Rename Dialog */}
      <FolderNameDialog open={creating} parentId={null} onOpenChange={setCreating} onDone={refetch} />
      <FolderNameDialog open={!!renaming} folder={renaming} parentId={null} onOpenChange={(o) => !o && setRenaming(null)} onDone={refetch} />
      <ArchiveItemDialog item={archiving} onClose={() => setArchiving(null)} onDone={refetch} />
      <SelectionBar selection={selection} pageItems={folders} onPick={(action) => setPicker({ action, items: selection.items })} />
      <FolderPickerDialog
        action={picker?.action ?? null}
        items={picker?.items ?? []}
        currentFolderId={null}
        onClose={() => setPicker(null)}
        onDone={() => { selection.clear(); refetch(); }}
      />
      <LibraryInfoDialog
        open={infoOpen}
        onOpenChange={setInfoOpen}
        totalFolders={data?.total}
        totalFiles={totalFilesOnPage}
      />
    </div>
  );
}

/** Grid or List of folder cards (top level or subfolders), with admin rename/archive. */
export function FolderCards({
  folders,
  isAdmin,
  onChanged,
  viewMode = "grid",
}: {
  folders: LibraryFolder[];
  isAdmin: boolean;
  onChanged: () => void;
  viewMode?: "grid" | "list";
}) {
  // Inside a LibraryDnd, cards can be selected, rearranged and dragged onto folders.
  const [renaming, setRenaming] = useState<LibraryFolder | null>(null);

  if (viewMode === "list") {
    return (
      <>
        <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[#262626]/40">
          <div className="grid grid-cols-12 gap-3 border-b border-white/[0.08] px-4 py-2.5 text-xs font-medium text-muted-foreground">
            <div className="col-span-6 sm:col-span-5">Folder Name</div>
            <div className="col-span-3 sm:col-span-3 text-center sm:text-left">Contents</div>
            <div className="hidden sm:col-span-3 sm:block">Created</div>
            <div className="col-span-3 sm:col-span-1 text-right">Actions</div>
          </div>
          <SortableArea items={folders} layout="list">
            <div className="divide-y divide-white/[0.06]">
              {folders.map((f) => (
                <SortableItem key={f.id} item={f}>
                  <FolderListItem folder={f} isAdmin={isAdmin} onRename={() => setRenaming(f)} onChanged={onChanged} />
                </SortableItem>
              ))}
            </div>
          </SortableArea>
        </div>
        <FolderNameDialog
          open={!!renaming}
          folder={renaming}
          parentId={renaming?.parent_id ?? null}
          onOpenChange={(o) => !o && setRenaming(null)}
          onDone={onChanged}
        />
      </>
    );
  }

  return (
    <>
      <SortableArea items={folders}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {folders.map((f) => (
            <SortableItem key={f.id} item={f} className="flex">
              <FolderCard folder={f} isAdmin={isAdmin} onRename={() => setRenaming(f)} onChanged={onChanged} />
            </SortableItem>
          ))}
        </div>
      </SortableArea>
      <FolderNameDialog
        open={!!renaming}
        folder={renaming}
        parentId={renaming?.parent_id ?? null}
        onOpenChange={(o) => !o && setRenaming(null)}
        onDone={onChanged}
      />
    </>
  );
}

/** A compact folder card that also accepts files dropped onto it (ChatGPT gray theme). */
export function FolderCard({
  folder: f,
  isAdmin,
  onRename,
  onChanged,
}: {
  folder: LibraryFolder;
  isAdmin: boolean;
  onRename: () => void;
  onChanged: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const drop = useFileDrop(async (picked) => {
    setUploading(true);
    try {
      await uploadLibraryFiles(f.id, picked, f.name);
    } finally {
      setUploading(false);
      onChanged();
    }
  }, !f.archived_at && !uploading);

  const files = f.file_count;
  const subfolders = f.subfolder_count;
  const isArchived = !!f.archived_at;

  return (
    <div
      {...drop.props}
      className={cn(
        "group relative flex w-full flex-row items-center justify-between gap-3 overflow-hidden rounded-xl border border-white/[0.08] bg-[#262626] px-4 py-3.5 transition-all duration-200 shadow-xs",
        "hover:border-white/20 hover:bg-[#2c2c2c] hover:shadow-md",
        drop.over && "border-white/40 bg-white/[0.08] ring-1 ring-white/30",
        isArchived && "opacity-75 border-dashed",
      )}
    >
      {/* Uploading progress overlay */}
      {uploading ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center gap-2 bg-[#212121]/90 backdrop-blur-xs">
          <Loader2 className="size-4 animate-spin text-zinc-300" />
          <p className="text-xs font-medium text-foreground">Uploading…</p>
        </div>
      ) : null}

      {/* Drop feedback overlay */}
      {drop.over ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-2 bg-white/[0.08] backdrop-blur-xs">
          <Upload className="size-4 animate-bounce text-white" />
          <p className="text-xs font-medium text-white">Drop to upload to {f.name}</p>
        </div>
      ) : null}

      {/* Left: Folder Icon */}
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-300 transition-colors",
          "group-hover:border-white/[0.15] group-hover:bg-white/[0.08] group-hover:text-white",
          isArchived && "opacity-60",
        )}
      >
        {isArchived ? (
          <Archive className="size-4.5 text-muted-foreground" />
        ) : (
          <Folder className="size-5 transition-transform group-hover:scale-105" />
        )}
      </div>

      {/* Middle: Title & Meta */}
      <div className="min-w-0 flex-1">
        <Link
          href={`/library/${f.id}`}
          draggable={false}
          className="group/link block min-w-0 after:absolute after:inset-0 focus-visible:outline-none"
        >
          <h3
            className="truncate text-sm font-medium text-zinc-200 transition-colors group-hover:text-white leading-tight"
            title={f.name}
          >
            {f.name}
          </h3>
        </Link>
        <p className="mt-1 truncate text-xs text-zinc-400 leading-none">
          {drop.over ? (
            "Drop to upload here"
          ) : (
            <>
              {subfolders > 0 ? `${subfolders} ${subfolders === 1 ? "folder" : "folders"} · ` : ""}
              {files} {files === 1 ? "file" : "files"}
            </>
          )}
        </p>
      </div>

      {/* Right: Actions Menu & subtle arrow */}
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        {isArchived ? (
          <Badge variant="outline" className="border-white/[0.1] bg-white/[0.04] text-[10px] text-zinc-400">
            Archived
          </Badge>
        ) : null}
        {isAdmin ? <FolderMenu folder={f} onRename={onRename} onDone={onChanged} /> : null}
        <ChevronRight className="size-3.5 text-zinc-500 opacity-0 transition-all group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:text-zinc-300" />
      </div>
    </div>
  );
}

/** List View item for folders */
export function FolderListItem({
  folder: f,
  isAdmin,
  onRename,
  onChanged,
}: {
  folder: LibraryFolder;
  isAdmin: boolean;
  onRename: () => void;
  onChanged: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const drop = useFileDrop(async (picked) => {
    setUploading(true);
    try {
      await uploadLibraryFiles(f.id, picked, f.name);
    } finally {
      setUploading(false);
      onChanged();
    }
  }, !f.archived_at && !uploading);

  const files = f.file_count;
  const subfolders = f.subfolder_count;
  const isArchived = !!f.archived_at;

  return (
    <div
      {...drop.props}
      className={cn(
        "group relative grid grid-cols-12 items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.04]",
        drop.over && "bg-white/10 ring-2 ring-white/30",
      )}
    >
      <div className="col-span-6 sm:col-span-5 flex items-center gap-3 min-w-0">
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg border",
            isArchived
              ? "border-white/10 bg-white/5 text-muted-foreground"
              : "border-white/[0.08] bg-white/[0.04] text-zinc-300",
          )}
        >
          {uploading ? (
            <Loader2 className="size-4 animate-spin text-zinc-300" />
          ) : isArchived ? (
            <Archive className="size-4 text-muted-foreground" />
          ) : (
            <Folder className="size-4" />
          )}
        </div>
        <Link
          href={`/library/${f.id}`}
          draggable={false}
          className="truncate font-medium text-sm text-foreground hover:text-white after:absolute after:inset-0"
          title={f.name}
        >
          {f.name}
        </Link>
      </div>

      <div className="col-span-3 sm:col-span-3 flex items-center gap-2 text-xs text-muted-foreground">
        {subfolders > 0 ? <span>{subfolders} {subfolders === 1 ? "folder" : "folders"} · </span> : null}
        <span>{files} {files === 1 ? "file" : "files"}</span>
      </div>

      <div className="hidden sm:col-span-3 sm:block text-xs text-muted-foreground">
        {formatDate(f.created_at)}
      </div>

      <div className="col-span-3 sm:col-span-1 flex justify-end">
        {isAdmin ? <FolderMenu folder={f} onRename={onRename} onDone={onChanged} /> : null}
      </div>
    </div>
  );
}

function FolderMenu({ folder, onRename, onDone }: { folder: LibraryFolder; onRename: () => void; onDone: () => void }) {
  const archived = !!folder.archived_at;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative z-10 size-7.5 text-muted-foreground hover:text-foreground hover:bg-white/10"
          aria-label={`Actions for ${folder.name}`}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {!archived ? (
          <DropdownMenuItem onSelect={onRename} className="gap-2 text-xs">
            <Pencil className="size-3.5" /> Rename
          </DropdownMenuItem>
        ) : null}
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
          title={archived ? `Restore "${folder.name}"?` : `Archive "${folder.name}"?`}
          description={
            archived
              ? "Its files can be shared again."
              : "Its files are hidden and stop opening from existing share links. Archive its subfolders first. You can restore it later."
          }
          confirmLabel={archived ? "Restore" : "Archive"}
          destructive={!archived}
          onConfirm={async () => {
            const r = await setFolderArchived({ id: folder.id, archived: !archived });
            if (!r.ok) {
              toast.error(r.error);
              return false;
            }
            toast.success(archived ? `"${folder.name}" restored` : `"${folder.name}" archived`);
            onDone();
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const COMMON_FOLDER_SUGGESTIONS = [
  "Brochures",
  "Price Lists",
  "Product Catalogs",
  "Site Photos",
  "Presentations",
  "Contracts",
];

/** Create a folder (optionally inside `parentId`) or rename `folder`. */
export function FolderNameDialog({
  open,
  folder,
  parentId,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  folder?: LibraryFolder | null;
  parentId: string | null;
  onOpenChange: (o: boolean) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [pending, start] = useTransition();
  const [wasOpen, setWasOpen] = useState(false);

  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setName(folder?.name ?? "");
      setInvalid(false);
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    start(async () => {
      const r = folder ? await renameFolder({ id: folder.id, name }) : await createFolder({ name, parentId });
      if (!r.ok) {
        setInvalid(true);
        toast.error(r.error);
        return;
      }
      toast.success(folder ? "Folder renamed" : `Folder "${name.trim()}" created`);
      onOpenChange(false);
      onDone();
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-zinc-300">
              {folder ? <Pencil className="size-4" /> : <FolderPlus className="size-4" />}
            </div>
            <div>
              <DialogTitle className="text-base">
                {folder ? "Rename folder" : parentId ? "New subfolder" : "New folder"}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {folder
                  ? "Existing customer share links will continue working."
                  : "Organize brochures, catalogs, and photos for easy customer sharing."}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form id="folder-name" onSubmit={submit} noValidate className="space-y-4 pt-2">
          <FieldGroup>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor="folder-name-input" className="text-xs">Folder Name</FieldLabel>
              <Input
                id="folder-name-input"
                autoFocus
                maxLength={80}
                placeholder="e.g. Brochures, Price lists, Project 2026"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setInvalid(false);
                }}
                aria-invalid={invalid}
                className="h-10 text-sm bg-[#1c1c1c]"
              />
            </Field>
          </FieldGroup>

          {/* Quick suggestions when creating a new folder */}
          {!folder ? (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">Quick suggestions:</p>
              <div className="flex flex-wrap gap-1.5">
                {COMMON_FOLDER_SUGGESTIONS.map((sug) => (
                  <button
                    key={sug}
                    type="button"
                    onClick={() => {
                      setName(sug);
                      setInvalid(false);
                    }}
                    className={cn(
                      "rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white",
                      name === sug && "border-white/30 bg-white/15 text-white",
                    )}
                  >
                    {sug}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </form>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="folder-name"
            disabled={pending || !name.trim()}
            className="gap-2"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {folder ? "Save changes" : "Create folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Explains library limits, supported file types, drag & drop shortcuts and customer sharing. */
export function LibraryInfoDialog({
  open,
  onOpenChange,
  totalFolders,
  totalFiles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totalFolders?: number;
  totalFiles?: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md border-white/[0.1] bg-[#212121] text-foreground">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl border border-white/[0.1] bg-white/[0.05] text-zinc-300">
              <Info className="size-4 text-zinc-300" />
            </div>
            <div>
              <DialogTitle className="text-base font-semibold text-foreground">
                Library Guide &amp; Specifications
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Asset formats, upload shortcuts, and sharing details.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-2.5 py-2 text-xs">
          {/* Formats & Size limits */}
          <div className="rounded-xl border border-white/[0.08] bg-[#262626] p-3.5 space-y-2">
            <div className="flex items-center gap-2.5 font-medium text-foreground">
              <div className="flex size-6 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04]">
                <FileText className="size-3.5 text-zinc-300" />
              </div>
              <span className="text-sm">Supported File Formats &amp; Limits</span>
            </div>
            <p className="text-muted-foreground leading-relaxed pl-8.5">
              Upload marketing collaterals, price lists, project specifications, and site photos.
            </p>
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5 pl-8.5">
              <Badge variant="secondary" className="px-2 py-0.5 text-[11px] font-mono border border-white/[0.08] bg-white/[0.05] text-zinc-300">
                PDF
              </Badge>
              <Badge variant="secondary" className="px-2 py-0.5 text-[11px] font-mono border border-white/[0.08] bg-white/[0.05] text-zinc-300">
                PNG
              </Badge>
              <Badge variant="secondary" className="px-2 py-0.5 text-[11px] font-mono border border-white/[0.08] bg-white/[0.05] text-zinc-300">
                JPG / JPEG
              </Badge>
              <Badge variant="secondary" className="px-2 py-0.5 text-[11px] font-mono border border-white/[0.08] bg-white/[0.05] text-zinc-300">
                WEBP
              </Badge>
              <span className="text-muted-foreground ml-1">· Up to 25 MB each</span>
            </div>
          </div>

          {/* Drag & drop */}
          <div className="rounded-xl border border-white/[0.08] bg-[#262626] p-3.5 space-y-2">
            <div className="flex items-center gap-2.5 font-medium text-foreground">
              <div className="flex size-6 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04]">
                <Upload className="size-3.5 text-zinc-300" />
              </div>
              <span className="text-sm">Fast Drag &amp; Drop Upload</span>
            </div>
            <p className="text-muted-foreground leading-relaxed pl-8.5">
              Drag files directly from your desktop onto any folder card to upload them without opening the folder. Inside any folder, drop anywhere on the screen.
            </p>
          </div>

          {/* Customer document sharing */}
          <div className="rounded-xl border border-white/[0.08] bg-[#262626] p-3.5 space-y-2">
            <div className="flex items-center gap-2.5 font-medium text-foreground">
              <div className="flex size-6 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04]">
                <Share2 className="size-3.5 text-zinc-300" />
              </div>
              <span className="text-sm">Customer Document Sharing</span>
            </div>
            <p className="text-muted-foreground leading-relaxed pl-8.5">
              Attach files from this library when sharing documents with leads. The CRM tracks customer opens and downloads on the lead&apos;s activity timeline.
            </p>
          </div>

          {/* Current stats */}
          {totalFolders !== undefined ? (
            <div className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-[#262626]/60 px-3.5 py-2.5 text-muted-foreground">
              <span className="text-xs">Current Library Status:</span>
              <span className="text-xs font-medium text-foreground">
                {formatCount(totalFolders)} {totalFolders === 1 ? "folder" : "folders"}
                {totalFiles !== undefined ? ` · ${formatCount(totalFiles)} files` : ""}
              </span>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-white/[0.1] bg-white/[0.05] hover:bg-white/[0.1] text-zinc-300 hover:text-white"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

