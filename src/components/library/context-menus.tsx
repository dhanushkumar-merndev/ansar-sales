"use client";

import { createContext, useContext, useState, useSyncExternalStore, useTransition } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Copy,
  Download,
  ExternalLink,
  FolderInput,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  RefreshCw,
  SquareCheck,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { LIBRARY_SORTS, type LibraryFile, type LibraryFolder, type LibraryItem, type LibrarySort } from "@/lib/library-queries";
import { setFileArchived, setFolderArchived } from "@/server/actions/library";

/** What a right-click on a folder or file can do in the current view. Admin-only actions are left out for others. */
export type LibraryItemActions = {
  open: (item: LibraryItem) => void;
  openInNewTab: (item: LibraryItem) => void;
  download?: (file: LibraryFile) => void;
  rename?: (folder: LibraryFolder) => void;
  toggleSelect?: (item: LibraryItem) => void;
  isSelected?: (item: LibraryItem) => boolean;
  move?: (item: LibraryItem) => void;
  copy?: (file: LibraryFile) => void;
  archive?: (item: LibraryItem) => void;
};

const ActionsCtx = createContext<LibraryItemActions | null>(null);
export const LibraryActionsProvider = ActionsCtx.Provider;

// Phones use long press to pick items up for dragging, so they keep no right-click menu.
const coarse = "(pointer: coarse)";
function subscribeCoarse(cb: () => void) {
  const m = window.matchMedia(coarse);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
const useIsTouch = () => useSyncExternalStore(subscribeCoarse, () => window.matchMedia(coarse).matches, () => false);

/** Right-click menu for one folder or file card. Renders its children unchanged outside a LibraryActionsProvider. */
export function ItemContextMenu({ item, children }: { item: LibraryItem; children: React.ReactNode }) {
  const a = useContext(ActionsCtx);
  const touch = useIsTouch();
  if (!a || touch) return <>{children}</>;
  const archived = !!item.archived_at;
  const selected = a.isSelected?.(item) ?? false;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* The page has its own menu; this one wins over it. */}
        <div className="contents" onContextMenu={(e) => e.stopPropagation()}>
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => a.open(item)}>
          {item.kind === "folder" ? <FolderOpen /> : <ExternalLink />} Open
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => a.openInNewTab(item)}>
          <ExternalLink /> Open in new tab
        </ContextMenuItem>
        {item.kind === "file" && a.download ? (
          <ContextMenuItem onSelect={() => a.download!(item)}>
            <Download /> Download
          </ContextMenuItem>
        ) : null}
        {a.rename || a.toggleSelect || a.move || a.copy ? <ContextMenuSeparator /> : null}
        {item.kind === "folder" && a.rename && !archived ? (
          <ContextMenuItem onSelect={() => a.rename!(item)}>
            <Pencil /> Rename
          </ContextMenuItem>
        ) : null}
        {a.toggleSelect && !archived ? (
          <ContextMenuItem onSelect={() => a.toggleSelect!(item)}>
            <SquareCheck /> {selected ? "Deselect" : "Select"}
          </ContextMenuItem>
        ) : null}
        {a.move && !archived ? (
          <ContextMenuItem onSelect={() => a.move!(item)}>
            <FolderInput /> Move to…
          </ContextMenuItem>
        ) : null}
        {item.kind === "file" && a.copy && !archived ? (
          <ContextMenuItem onSelect={() => a.copy!(item)}>
            <Copy /> Copy to…
          </ContextMenuItem>
        ) : null}
        {a.archive ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant={archived ? "default" : "destructive"} onSelect={() => a.archive!(item)}>
              {archived ? <ArchiveRestore /> : <Archive />} {archived ? "Restore" : "Archive"}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Right-click menu for the empty space of a Library page. */
export function BackgroundContextMenu({
  children,
  className,
  newFolderLabel,
  onNewFolder,
  onUpload,
  onSelect,
  selecting,
  sort,
  onSort,
  foldersFirst,
  onFoldersFirst,
  viewMode,
  onViewMode,
  archived,
  onArchived,
  onRefresh,
}: {
  children: React.ReactNode;
  className?: string;
  newFolderLabel: string;
  onNewFolder?: () => void;
  onUpload?: () => void;
  onSelect?: () => void;
  selecting?: boolean;
  sort: LibrarySort;
  onSort: (s: LibrarySort) => void;
  foldersFirst?: boolean;
  onFoldersFirst?: (on: boolean) => void;
  viewMode: "grid" | "list";
  onViewMode: (v: "grid" | "list") => void;
  archived?: boolean;
  onArchived?: (on: boolean) => void;
  onRefresh: () => void;
}) {
  const touch = useIsTouch();
  if (touch) return <div className={className}>{children}</div>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={className}>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {onNewFolder ? (
          <ContextMenuItem onSelect={onNewFolder}>
            <FolderPlus /> {newFolderLabel}
          </ContextMenuItem>
        ) : null}
        {onUpload ? (
          <ContextMenuItem onSelect={onUpload}>
            <Upload /> Upload files
          </ContextMenuItem>
        ) : null}
        {onSelect ? (
          <ContextMenuItem onSelect={onSelect}>
            <SquareCheck /> {selecting ? "Stop selecting" : "Select items"}
          </ContextMenuItem>
        ) : null}
        {onNewFolder || onUpload || onSelect ? <ContextMenuSeparator /> : null}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <ArrowUpDown /> Sort by
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            <ContextMenuRadioGroup value={sort} onValueChange={(v) => v in LIBRARY_SORTS && onSort(v as LibrarySort)}>
              {(Object.keys(LIBRARY_SORTS) as LibrarySort[]).map((k) => (
                <ContextMenuRadioItem key={k} value={k}>
                  {LIBRARY_SORTS[k].label}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
            {onFoldersFirst ? (
              <>
                <ContextMenuSeparator />
                <ContextMenuCheckboxItem checked={!!foldersFirst} onCheckedChange={(c) => onFoldersFirst(c === true)}>
                  Folders first
                </ContextMenuCheckboxItem>
              </>
            ) : null}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onSelect={() => onViewMode(viewMode === "grid" ? "list" : "grid")}>
          {viewMode === "grid" ? <List /> : <LayoutGrid />} {viewMode === "grid" ? "List view" : "Grid view"}
        </ContextMenuItem>
        {onArchived ? (
          <ContextMenuCheckboxItem checked={!!archived} onCheckedChange={(c) => onArchived(c === true)}>
            Show archived
          </ContextMenuCheckboxItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onRefresh}>
          <RefreshCw /> Refresh
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Confirms archiving or restoring one folder or file (Admin), opened from the right-click menu. */
export function ArchiveItemDialog({ item, onClose, onDone }: { item: LibraryItem | null; onClose: () => void; onDone: () => void }) {
  const [pending, start] = useTransition();
  // Keep the last item while the dialog animates closed.
  const [shown, setShown] = useState<LibraryItem | null>(item);
  if (item && item !== shown) setShown(item);
  const it = item ?? shown;
  const archived = !!it?.archived_at;
  const folder = it?.kind === "folder";

  const confirm = () =>
    start(async () => {
      if (!it) return;
      const r = folder ? await setFolderArchived({ id: it.id, archived: !archived }) : await setFileArchived({ id: it.id, archived: !archived });
      if (!r.ok) return void toast.error(r.error);
      toast.success(archived ? `"${it.name}" restored` : `"${it.name}" archived`);
      onDone();
      onClose();
    });

  return (
    <AlertDialog open={!!item} onOpenChange={(o) => !o && !pending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{archived ? `Restore "${it?.name}"?` : `Archive "${it?.name}"?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {folder
              ? archived ? "Its files can be shared again." : "Its files are hidden and stop opening from existing share links. Archive its subfolders first. You can restore it later."
              : archived ? "It can be shared again and reopens from existing links." : "It disappears from the library and stops opening from existing share links. You can restore it later."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant={archived ? "default" : "destructive"} disabled={pending} onClick={confirm}>
            {pending && <Loader2 className="animate-spin" />}
            {archived ? "Restore" : "Archive"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
