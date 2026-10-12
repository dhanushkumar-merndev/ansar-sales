"use client";

import { Fragment, useRef, useState, useTransition } from "react";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ChevronRight, FolderClosed, FolderOpen, FolderPlus, Lock, MoreHorizontal, Pencil, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataPagination } from "@/components/common/data-pagination";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { useFileDrop } from "@/components/library/upload";
import { FileKindIcon, FileStatusBadge } from "@/components/projects/files/file-badges";
import { FileSheet } from "@/components/projects/files/file-sheet";
import { PROJECT_FILE_ACCEPT, uploadProjectFiles } from "@/components/projects/files/upload";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { fetchArchivedFolders, fetchFolderFiles, fetchProjectFolders, fetchStorageUsage } from "@/lib/project-queries";
import { formatBytes, type ArchivedProjectFolder, type ProjectDetail, type ProjectFolder } from "@/lib/projects";
import { cleanSearch } from "@/lib/search";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { archiveProjectFolder, createProjectFolder, deleteProjectFolder, moveProjectFile, moveProjectFolder, renameProjectFolder, restoreProjectFolder } from "@/server/actions/project-files";

// A file row being dragged onto another folder (to move it), as opposed to files from the computer.
const FILE_DRAG = "application/x-project-file";

/**
 * A folder as a drop target: files from the computer upload into it, a file row dragged from the list moves
 * into it. Marked like the Library's zones (data-file-drop), so only the innermost zone lights up.
 */
function useFolderDrop(onFiles: (files: File[]) => void, onMove?: (fileId: string) => void) {
  const [over, setOver] = useState<"files" | "move" | null>(null);
  const kind = (e: React.DragEvent) => e.dataTransfer.types.includes("Files") ? "files" : onMove && e.dataTransfer.types.includes(FILE_DRAG) ? "move" : null;
  const innermost = (e: React.DragEvent) => (e.target as Element).closest?.("[data-file-drop]") === e.currentTarget;
  return {
    over,
    props: {
      "data-file-drop": "",
      onDragOver: (e: React.DragEvent) => {
        const k = kind(e);
        if (!k) return;
        if (!innermost(e)) { setOver(null); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = k === "files" ? "copy" : "move";
        setOver(k);
      },
      onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); },
      onDrop: (e: React.DragEvent) => {
        const k = kind(e);
        if (!k || !innermost(e)) return;
        e.preventDefault();
        setOver(null);
        if (k === "files") { const picked = Array.from(e.dataTransfer.files); if (picked.length) onFiles(picked); }
        else { const id = e.dataTransfer.getData(FILE_DRAG); if (id) onMove?.(id); }
      },
    },
  };
}

const FILE_TABLES = ["project_folders", "project_files", "project_file_versions", "project_file_comments", "project_file_events"];

/** Folders as a tree: children by parent, and the path from the top to any folder. */
function folderTree(all: ProjectFolder[]) {
  const children = new Map<string | null, ProjectFolder[]>();
  for (const f of all) children.set(f.parent_id, [...(children.get(f.parent_id) ?? []), f]);
  const byId = new Map(all.map((f) => [f.id, f]));
  const path = (id: string | null) => {
    const out: ProjectFolder[] = [];
    for (let f = id ? byId.get(id) : undefined; f && out.length < 50; f = f.parent_id ? byId.get(f.parent_id) : undefined) out.unshift(f);
    return out;
  };
  return { kids: (id: string | null) => children.get(id) ?? [], path, byId };
}

/** The project's own file store: folders (with sub-folders), versions, review and what the client can see. */
export function ProjectFilesTab({ detail }: { detail: ProjectDetail }) {
  const me = useProfile();
  const projectId = detail.project.id;
  const manage = detail.can.manage;
  const { params, set } = useUrlState();
  const folders = useLiveQuery({ queryKey: `project-folders:${me.id}:${projectId}`, fetcher: (s) => fetchProjectFolders(projectId, s), tables: ["project_folders"] });
  const tree = folderTree(folders.data ?? []);
  const requested = params.get("folder");
  const folder = (requested ? tree.byId.get(requested) : undefined) ?? tree.kids(null)[0] ?? null;
  const folderId = folder?.id ?? null;
  const trail = tree.path(folderId);
  const subfolders = tree.kids(folderId);
  const [input, setInput] = useState("");
  const q = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const files = useLiveQuery({
    queryKey: `project-files:${me.id}:${projectId}:${folderId}:${q}:${page}:${pageSize}`,
    fetcher: (s) => fetchFolderFiles({ projectId, folderId, q, page, pageSize }, s),
    enabled: !!folderId, tables: FILE_TABLES,
  });
  const usage = useLiveQuery({ queryKey: `project-usage:${me.id}:${projectId}`, fetcher: (s) => fetchStorageUsage(projectId, s), tables: ["project_file_versions", "project_files"] });
  // Same as the Library: pick files or drop them on a folder; one toast shows the progress.
  const picker = useRef<HTMLInputElement>(null);
  const target = useRef<{ folderId: string; folderName: string; fileId?: string } | undefined>(undefined);
  const [uploading, setUploading] = useState(false);
  const openFile = params.get("file");
  // Where a new folder is being typed: inside the open folder ("here") or at the top of the tree.
  const [newFolder, setNewFolder] = useState<{ at: "here" | "top"; name: string } | null>(null);
  const [pending, start] = useTransition();

  const refresh = () => { files.refetch(); usage.refetch(); };
  const upload = async (picked: File[], to: { folderId: string; folderName: string; fileId?: string }) => {
    if (!picked.length) return;
    setUploading(true);
    try {
      await uploadProjectFiles(to.folderId, picked, { folderName: to.folderName, fileId: to.fileId, onUploaded: refresh });
    } finally {
      setUploading(false);
    }
  };
  const choose = (to: { folderId: string; folderName: string; fileId?: string }) => {
    target.current = to;
    if (picker.current) { picker.current.multiple = !to.fileId; picker.current.click(); }
  };
  const drop = useFileDrop((picked) => folder && void upload(picked, { folderId: folder.id, folderName: folder.name }), !!folder);
  const open = (id: string) => { set({ folder: id, file: null }); setPage(1); setInput(""); setNewFolder(null); };
  const addFolder = (name: string, parentId: string | null) => start(async () => {
    const r = await createProjectFolder({ projectId, parentId, name });
    if (!r.ok) return void toast.error(r.error);
    setNewFolder(null);
    toast.success(`Folder “${name.trim()}” created`);
    folders.refetch();
    open(r.data.id);
  });
  // Right-click → Move up / down (admin or this project's architect manager; the database checks it again).
  const move = manage ? (id: string, direction: "up" | "down") => start(async () => {
    const r = await moveProjectFolder({ id, direction });
    if (!r.ok) return void toast.error(r.error);
    folders.refetch();
  }) : undefined;
  // Drag a file row onto another folder to move it there.
  const [dragging, setDragging] = useState<string | null>(null);
  const moveFile = (fileId: string, to: ProjectFolder) => {
    if (to.id === folderId) return;
    start(async () => {
      const r = await moveProjectFile({ id: fileId, folderId: to.id });
      if (!r.ok) return void toast.error(r.error);
      const name = files.data?.items.find((f) => f.id === fileId)?.name;
      toast.success(`${name ?? "File"} moved to ${to.name}`, { action: { label: "Open folder", onClick: () => open(to.id) } });
      refresh();
    });
  };
  // Archive: whoever made the folder, or a manager; managers restore or delete it later (Archived folders).
  const canArchive = (f: ProjectFolder) => !f.system_key && (manage || f.created_by === me.id);
  const [archiving, setArchiving] = useState<ProjectFolder | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const archived = useLiveQuery({
    queryKey: `project-folders-archived:${me.id}:${projectId}`, fetcher: (s) => fetchArchivedFolders(projectId, s),
    tables: ["project_folders", "project_files"], enabled: manage,
  });
  const archive = async (f: ProjectFolder) => {
    const r = await archiveProjectFolder({ id: f.id });
    if (!r.ok) { toast.error(r.error); return false; }
    const inside = [r.data.files ? `${r.data.files} file${r.data.files === 1 ? "" : "s"}` : "", r.data.folders > 1 ? `${r.data.folders - 1} sub-folder${r.data.folders === 2 ? "" : "s"}` : ""].filter(Boolean);
    toast.success(`“${f.name}” archived`, { description: inside.length ? `${inside.join(" and ")} went with it.` : undefined });
    if (trail.some((x) => x.id === f.id)) open(f.parent_id ?? tree.kids(null).find((x) => x.id !== f.id)?.id ?? "");
    folders.refetch();
    archived.refetch();
  };

  if (folders.error && !folders.data) return <ErrorState message={folders.error} onRetry={folders.refetch} />;
  if (!folders.data) return <ListSkeleton rows={5} />;
  const pct = usage.data ? Math.min(100, (Number(usage.data.used) / Number(usage.data.quota)) * 100) : 0;
  const pathOf = (id: string) => tree.path(id).map((f) => f.name).join(" › ");
  const searching = Boolean(q);
  const nothing = !searching && !subfolders.length && !files.data?.total;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
      <aside className="space-y-3">
        <nav aria-label="Folders" className="max-h-[50dvh] overflow-y-auto lg:max-h-[calc(100dvh-16rem)]">
          <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-x-visible" role="tree">
            {tree.kids(null).map((f, i, all) => <TreeNode key={f.id} folder={f} depth={0} tree={tree} openPath={trail.map((x) => x.id)} current={folderId} onOpen={open}
              onMove={move} canArchive={canArchive} onArchive={setArchiving} first={i === 0} last={i === all.length - 1}
              onDropFiles={(picked, f) => void upload(picked, { folderId: f.id, folderName: f.name })} onDropFile={moveFile} />)}
          </ul>
        </nav>
        <p className="hidden px-2 text-xs text-muted-foreground lg:block">
          {dragging ? "Drop on a folder to move the file there." : "Drop files on a folder to upload them there, or drag a file onto a folder to move it."}
        </p>
        {newFolder?.at === "top" ? (
          <NewFolderForm value={newFolder.name} pending={pending} onChange={(name) => setNewFolder({ at: "top", name })} onCancel={() => setNewFolder(null)}
            onSubmit={() => addFolder(newFolder.name, null)} />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setNewFolder({ at: "top", name: "" })}><FolderPlus /> New top-level folder</Button>
        )}
        {manage && archived.data?.length ? (
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setShowArchived(true)}>
            <Archive /> Archived folders ({archived.data.length})
          </Button>
        ) : null}
        {usage.data ? (
          <div className="space-y-1 rounded-lg border p-3 text-xs">
            <div className="flex justify-between"><span className="text-muted-foreground">Storage</span><span className="tabular-nums">{formatBytes(Number(usage.data.used))} of {formatBytes(Number(usage.data.quota))}</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full", pct > 90 ? "bg-red-400" : pct > 75 ? "bg-amber-400" : "bg-emerald-400")} style={{ width: `${Math.max(pct, 1)}%` }} /></div>
            <div className="text-muted-foreground">{usage.data.files} file{usage.data.files === 1 ? "" : "s"}</div>
          </div>
        ) : null}
      </aside>

      <section {...drop.props} className={cn("relative min-w-0 space-y-3 rounded-xl", drop.over && "ring-2 ring-sky-400/60 ring-offset-4 ring-offset-background")}>
        {drop.over ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-sky-400/10 text-sm font-medium text-sky-200">
            Drop to upload to {folder?.name}
          </div>
        ) : null}
        <input ref={picker} type="file" className="hidden" accept={PROJECT_FILE_ACCEPT} aria-hidden tabIndex={-1}
          onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ""; if (target.current) void upload(picked, target.current); }} />

        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="Folder path" className="flex min-w-0 flex-wrap items-center gap-1 font-medium">
            {trail.map((f, i) => (
              <Fragment key={f.id}>
                {i ? <ChevronRight className="size-4 shrink-0 text-muted-foreground" /> : null}
                {i < trail.length - 1 ? (
                  <button type="button" className="truncate text-muted-foreground hover:text-foreground hover:underline" onClick={() => open(f.id)}>{f.name}</button>
                ) : (
                  <h3 className="flex items-center gap-1.5 truncate">{f.restricted ? <Lock className="size-4" /> : null}{f.name}</h3>
                )}
              </Fragment>
            ))}
          </nav>
          {folder?.restricted ? <span className="text-xs text-muted-foreground">Admin and Accounts only</span> : null}
          {folder && canArchive(folder) ? <FolderMenu folder={folder} canRename={manage} onChanged={folders.refetch} onArchive={() => setArchiving(folder)} /> : null}
          <FetchingIndicator show={files.isFetching && !files.isInitialLoading} />
          <span className="flex-1" />
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" className="w-56 pl-8" placeholder="Search all files" value={input} maxLength={100} onChange={(e) => { setInput(e.target.value); setPage(1); }} aria-label="Search files" />
          </div>
          {folder && !folder.restricted ? (
            <Button variant="outline" onClick={() => setNewFolder({ at: "here", name: "" })} disabled={newFolder?.at === "here"}><FolderPlus /> New folder</Button>
          ) : null}
          <Button onClick={() => folder && choose({ folderId: folder.id, folderName: folder.name })} disabled={!folder || uploading}><Upload /> Upload</Button>
        </div>

        {newFolder?.at === "here" && folder ? (
          <Card className="flex-row items-center gap-2 px-3 py-2">
            <FolderPlus className="size-5 shrink-0 text-muted-foreground" />
            <NewFolderForm value={newFolder.name} pending={pending} placeholder={`New folder inside ${folder.name}`} onChange={(name) => setNewFolder({ at: "here", name })}
              onCancel={() => setNewFolder(null)} onSubmit={() => addFolder(newFolder.name, folder.id)} />
          </Card>
        ) : null}

        {!searching && subfolders.length ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {subfolders.map((f) => (
              <SubfolderTile key={f.id} folder={f} subfolders={tree.kids(f.id).length} onOpen={() => open(f.id)}
                onArchive={canArchive(f) ? () => setArchiving(f) : undefined}
                onDrop={(picked) => void upload(picked, { folderId: f.id, folderName: f.name })} onDropFile={(id) => moveFile(id, f)} />
            ))}
          </div>
        ) : null}

        {files.error && !files.data ? <ErrorState message={files.error} onRetry={files.refetch} /> : files.isInitialLoading ? <ListSkeleton /> : nothing ? (
          <button type="button" className="block w-full rounded-2xl text-left hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => folder && choose({ folderId: folder.id, folderName: folder.name })} disabled={!folder || uploading}>
            <EmptyState title="This folder is empty" description={`Drop files here, or click to choose them: drawings, photos, decks or BOQs. Big DWG/SketchUp files are fine (up to 5 GB).${folder?.restricted ? "" : " Use New folder to group them."}`} />
          </button>
        ) : searching && !files.data?.total ? (
          <EmptyState title="No files match" />
        ) : files.data?.total ? (
          <>
            <Card className="gap-0 divide-y py-0">
              {files.data.items.map((f) => (
                <button key={f.id} type="button" onClick={() => set({ file: f.id })} draggable title="Drag onto a folder to move it"
                  onDragStart={(e) => { e.dataTransfer.setData(FILE_DRAG, f.id); e.dataTransfer.effectAllowed = "move"; setDragging(f.id); }}
                  onDragEnd={() => setDragging(null)}
                  className={cn("flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-accent/30", dragging === f.id && "opacity-50")}>
                  <FileKindIcon kind={f.kind} className="size-5" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{f.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {searching ? <span className="text-foreground/80">{pathOf(f.folder_id)} · </span> : null}
                      v{f.current?.version_no ?? 1}{f.versions > 1 ? ` of ${f.versions}` : ""} · {f.current ? formatBytes(f.current.size_bytes) : "—"} · {f.current?.uploaded_by ?? "—"} · {formatRelative(f.updated_at)}
                      {f.phase ? ` · ${f.phase.name}` : ""}{f.open_comments ? ` · ${f.open_comments} open note${f.open_comments === 1 ? "" : "s"}` : ""}
                    </div>
                  </div>
                  {f.current ? <FileStatusBadge status={f.current.status} /> : null}
                  {f.client_seen_at ? <span className="text-xs text-emerald-300">Client opened {formatRelative(f.client_seen_at)}</span>
                    : f.client_version ? <span className="text-xs text-muted-foreground">Client sees v{f.client_version.version_no}</span> : null}
                </button>
              ))}
            </Card>
            <DataPagination page={page} pageSize={pageSize} total={files.data.total} disabled={files.isFetching} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
          </>
        ) : null}
      </section>

      <FileSheet fileId={openFile} onClose={() => set({ file: null })} onChanged={refresh}
        onUploadVersion={(fileId, folderId) => choose({ fileId, folderId, folderName: tree.byId.get(folderId)?.name ?? "" })} />

      <ConfirmDialog open={!!archiving} onOpenChange={(o) => !o && setArchiving(null)} title={`Archive “${archiving?.name ?? ""}”?`} confirmLabel="Archive"
        description={`Its sub-folders and files go with it, out of everyone's view. ${manage ? "You can restore it, or delete it for good, from Archived folders." : "The architect manager or an admin can restore it, or delete it for good."}`}
        onConfirm={async () => { if (archiving) return archive(archiving); }} />
      {manage ? <ArchivedFoldersSheet open={showArchived} onOpenChange={setShowArchived} items={archived.data ?? []}
        onChanged={() => { archived.refetch(); folders.refetch(); usage.refetch(); }} /> : null}
    </div>
  );
}

/** One folder in the sidebar tree; the path to the open folder stays expanded. */
function TreeNode({ folder, depth, tree, openPath, current, onOpen, onMove, canArchive, onArchive, first, last, onDropFiles, onDropFile }: {
  folder: ProjectFolder; depth: number; tree: ReturnType<typeof folderTree>; openPath: string[]; current: string | null; onOpen: (id: string) => void;
  onMove?: (id: string, direction: "up" | "down") => void; canArchive: (f: ProjectFolder) => boolean; onArchive: (f: ProjectFolder) => void; first: boolean; last: boolean;
  onDropFiles: (files: File[], to: ProjectFolder) => void; onDropFile: (fileId: string, to: ProjectFolder) => void;
}) {
  const drop = useFolderDrop((picked) => onDropFiles(picked, folder), (id) => onDropFile(id, folder));
  const kids = tree.kids(folder.id);
  const onPath = openPath.includes(folder.id);
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const shown = expanded ?? onPath;
  const Icon = folder.restricted ? Lock : folder.id === current || (shown && kids.length) ? FolderOpen : FolderClosed;
  const row = (
    <div {...drop.props} className={cn("flex items-center rounded-lg text-sm", folder.id === current ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      drop.over && "bg-sky-400/15 text-foreground ring-1 ring-sky-400/60")}
      style={{ paddingLeft: `${depth * 14}px` }} title={drop.over ? (drop.over === "files" ? `Drop to upload to ${folder.name}` : `Drop to move to ${folder.name}`) : undefined}>
      {kids.length ? (
        <button type="button" className="hidden rounded p-1 hover:bg-accent lg:block" aria-label={shown ? `Collapse ${folder.name}` : `Expand ${folder.name}`} onClick={() => setExpanded(!shown)}>
          <ChevronRight className={cn("size-3.5 transition-transform", shown && "rotate-90")} />
        </button>
      ) : <span className="hidden w-[22px] lg:block" />}
      <button type="button" onClick={() => onOpen(folder.id)} title={folder.name}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-3 pl-1 text-left lg:items-start lg:pl-0.5">
        <Icon className="size-4 shrink-0 lg:mt-0.5" />
        {/* Whole names: wrap (up to two lines) in the side tree, one line in the phone's sideways list. */}
        <span className="min-w-0 whitespace-nowrap lg:line-clamp-2 lg:whitespace-normal lg:break-words">{folder.name}</span>
      </button>
    </div>
  );
  return (
    <li role="treeitem" aria-selected={folder.id === current} aria-expanded={kids.length ? shown : undefined} className="shrink-0">
      {(onMove && !(first && last)) || canArchive(folder) ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent>
            {onMove && !(first && last) ? (
              <>
                <ContextMenuItem disabled={first} onSelect={() => onMove(folder.id, "up")}><ArrowUp /> Move up</ContextMenuItem>
                <ContextMenuItem disabled={last} onSelect={() => onMove(folder.id, "down")}><ArrowDown /> Move down</ContextMenuItem>
              </>
            ) : null}
            {onMove && !(first && last) && canArchive(folder) ? <ContextMenuSeparator /> : null}
            {canArchive(folder) ? <ContextMenuItem onSelect={() => onArchive(folder)}><Archive /> Archive</ContextMenuItem> : null}
          </ContextMenuContent>
        </ContextMenu>
      ) : row}
      {kids.length && shown ? (
        <ul role="group" className="hidden lg:block">
          {kids.map((k, i) => <TreeNode key={k.id} folder={k} depth={depth + 1} tree={tree} openPath={openPath} current={current} onOpen={onOpen}
            onMove={onMove} canArchive={canArchive} onArchive={onArchive} first={i === 0} last={i === kids.length - 1} onDropFiles={onDropFiles} onDropFile={onDropFile} />)}
        </ul>
      ) : null}
    </li>
  );
}

/** A sub-folder above the files: click to open, drop files on it to upload straight into it, right-click to archive. */
function SubfolderTile({ folder, subfolders, onOpen, onArchive, onDrop, onDropFile }: {
  folder: ProjectFolder; subfolders: number; onOpen: () => void; onArchive?: () => void; onDrop: (files: File[]) => void; onDropFile: (fileId: string) => void;
}) {
  const drop = useFolderDrop(onDrop, onDropFile);
  const tile = (
    <button type="button" {...drop.props} onClick={onOpen}
      className={cn("flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left hover:bg-accent/30", drop.over && "border-sky-400/70 bg-sky-400/10")}>
      <FolderClosed className="size-5 shrink-0 text-amber-300/80" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{folder.name}</span>
        <span className="block text-xs text-muted-foreground">{drop.over === "files" ? "Drop to upload here" : drop.over === "move" ? "Drop to move the file here" : subfolders ? `${subfolders} folder${subfolders === 1 ? "" : "s"} inside` : "Folder"}</span>
      </span>
      <ChevronRight className="size-4 text-muted-foreground" />
    </button>
  );
  if (!onArchive) return tile;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{tile}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}><FolderOpen /> Open</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onArchive}><Archive /> Archive</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function NewFolderForm({ value, onChange, onSubmit, onCancel, pending, placeholder = "Folder name" }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; onCancel: () => void; pending: boolean; placeholder?: string;
}) {
  return (
    <form className="flex flex-1 gap-1" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onSubmit(); }}>
      <Input autoFocus value={value} maxLength={80} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label="Folder name"
        onKeyDown={(e) => e.key === "Escape" && onCancel()} />
      <Button type="submit" size="sm" className="h-9" disabled={pending || !value.trim()}>Create</Button>
      <Button type="button" size="sm" variant="ghost" className="h-9" onClick={onCancel}>Cancel</Button>
    </form>
  );
}

/** The open folder's menu: rename (managers) and archive (managers or whoever made it); the standard folders stay. */
function FolderMenu({ folder, canRename, onChanged, onArchive }: { folder: ProjectFolder; canRename: boolean; onChanged: () => void; onArchive: () => void }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (renaming !== null) {
    return (
      <form className="flex gap-1" onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await renameProjectFolder({ id: folder.id, name: renaming });
          if (!r.ok) return void toast.error(r.error);
          setRenaming(null);
          onChanged();
        });
      }}>
        <Input autoFocus className="h-8 w-48" value={renaming} maxLength={80} aria-label="Folder name" onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setRenaming(null)} />
        <Button type="submit" size="sm" disabled={pending || !renaming.trim()}>Save</Button>
      </form>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${folder.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {canRename ? <DropdownMenuItem onSelect={() => setRenaming(folder.name)}><Pencil /> Rename</DropdownMenuItem> : null}
        <DropdownMenuItem onSelect={onArchive}><Archive /> Archive</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Admin / architect manager: archived folders, newest first, to restore or delete for good. */
function ArchivedFoldersSheet({ open, onOpenChange, items, onChanged }: {
  open: boolean; onOpenChange: (open: boolean) => void; items: ArchivedProjectFolder[]; onChanged: () => void;
}) {
  const [pending, start] = useTransition();
  const restore = (f: ArchivedProjectFolder) => start(async () => {
    const r = await restoreProjectFolder({ id: f.id });
    if (!r.ok) return void toast.error(r.error);
    toast.success(`“${f.name}” restored`);
    onChanged();
  });
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Archived folders</SheetTitle>
          <SheetDescription>Restore a folder with everything that was in it, or delete it for good.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {!items.length ? <p className="py-8 text-center text-sm text-muted-foreground">Nothing archived.</p> : (
            <ul className="divide-y rounded-lg border">
              {items.map((f) => {
                const inside = [`${f.files} file${f.files === 1 ? "" : "s"}`, f.folders ? `${f.folders} sub-folder${f.folders === 1 ? "" : "s"}` : "", f.bytes ? formatBytes(Number(f.bytes)) : ""].filter(Boolean).join(" · ");
                return (
                  <li key={f.id} className="space-y-2 px-3 py-3">
                    <div className="flex items-start gap-2">
                      <FolderClosed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium break-words">{f.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {f.parent_name ? `In ${f.parent_name} · ` : ""}{inside}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Archived {formatRelative(f.archived_at)}{f.archived_by ? ` by ${f.archived_by}` : ""}{f.created_by && f.created_by !== f.archived_by ? ` · made by ${f.created_by}` : ""}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pl-6">
                      <Button size="sm" variant="outline" disabled={pending || f.parent_archived} onClick={() => restore(f)}
                        title={f.parent_archived ? `“${f.parent_name}” is archived too. Restore it first.` : undefined}>
                        <ArchiveRestore /> Restore
                      </Button>
                      <ConfirmDialog destructive confirmLabel="Delete for good"
                        trigger={<Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300" disabled={pending}><Trash2 /> Delete for good</Button>}
                        title={`Delete “${f.name}” for good?`}
                        description={`${inside}, with every version, note and history, will be deleted. This can't be undone.`}
                        onConfirm={async () => {
                          const r = await deleteProjectFolder({ id: f.id });
                          if (!r.ok) { toast.error(r.error); return false; }
                          toast.success(`“${f.name}” deleted`);
                          onChanged();
                        }} />
                      {f.parent_archived ? <span className="text-xs text-muted-foreground">Restore “{f.parent_name}” first</span> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
