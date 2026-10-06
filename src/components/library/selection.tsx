"use client";

import { useMemo, useState } from "react";
import { Copy, Folder, FolderInput, Home, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { copyLibraryFiles } from "@/components/library/upload";
import type { DropTarget, LibrarySelection } from "@/components/library/sorting";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useLiveQuery } from "@/hooks/use-live-query";
import { fetchFolderOptions, type LibraryFile, type LibraryItem } from "@/lib/library-queries";
import { cn } from "@/lib/utils";
import { moveLibraryItems } from "@/server/actions/library";

const plural = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/** Moves items (Admin) and reports the result. Returns whether anything changed. */
export async function moveItems(items: LibraryItem[], target: DropTarget) {
  if (target.id === null && items.some((i) => i.kind === "file")) {
    toast.error("Files have to stay inside a folder. Drop them on a folder instead.");
    return false;
  }
  const r = await moveLibraryItems({ targetFolderId: target.id, items: items.map(({ kind, id }) => ({ kind, id })) });
  if (!r.ok) {
    toast.error(r.error);
    return false;
  }
  if (r.data.moved === 0) toast.message(`Already in ${target.name}`);
  else toast.success(`Moved ${plural(r.data.moved)} to ${target.name}`);
  return r.data.moved > 0;
}

/** Floating bar while selecting: count, select all, Move to…, Copy to… */
export function SelectionBar({ selection, pageItems, onPick }: {
  selection: LibrarySelection;
  pageItems: LibraryItem[];
  onPick: (action: "move" | "copy") => void;
}) {
  if (!selection.selecting) return null;
  const n = selection.items.length;
  const hasFolder = selection.items.some((i) => i.kind === "folder");
  return (
    <div
      role="toolbar"
      aria-label="Selected items"
      className="fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl border border-white/[0.12] bg-[#1f1f1f]/95 px-3 py-2 shadow-2xl backdrop-blur"
    >
      <span className="text-sm font-medium tabular-nums">{n ? `${n} selected` : "Select items"}</span>
      <Button variant="ghost" size="sm" className="text-xs" onClick={() => selection.selectAll(pageItems)} disabled={!pageItems.length}>
        Select all
      </Button>
      <div className="ml-auto flex items-center gap-1.5">
        <Button size="sm" className="gap-1.5 text-xs" disabled={!n} onClick={() => onPick("move")}>
          <FolderInput className="size-3.5" /> Move to…
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-xs"
          disabled={!n || hasFolder}
          title={hasFolder ? "Only files can be copied" : undefined}
          onClick={() => onPick("copy")}
        >
          <Copy className="size-3.5" /> Copy to…
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => selection.setSelecting(false)} aria-label="Stop selecting">
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** Pick a folder to move or copy the selected items into. */
export function FolderPickerDialog({ action, items, currentFolderId, onClose, onDone }: {
  action: "move" | "copy" | null;
  items: LibraryItem[];
  /** The folder the items are in now (null = top level). */
  currentFolderId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const open = !!action;
  const options = useLiveQuery({ queryKey: "library-folder-options", fetcher: fetchFolderOptions, tables: ["library_folders"], enabled: open });
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (openedFor !== action) {
    setOpenedFor(action);
    setFilter("");
    setTarget(null);
  }

  const onlyFolders = items.every((i) => i.kind === "folder");
  // A folder can't go into itself or anything below it.
  const blocked = useMemo(() => {
    const movedIds = new Set(items.filter((i) => i.kind === "folder").map((i) => i.id));
    const movedPaths = (options.data ?? []).filter((o) => movedIds.has(o.id)).map((o) => o.path);
    return (o: { id: string; path: string }) =>
      (action === "move" && o.id === currentFolderId) || movedPaths.some((p) => o.path === p || o.path.startsWith(`${p} / `));
  }, [items, options.data, action, currentFolderId]);
  const shown = (options.data ?? []).filter((o) => o.path.toLowerCase().includes(filter.trim().toLowerCase()));

  async function confirm() {
    if (!action || !target) return;
    setPending(true);
    try {
      const ok = action === "move" ? await moveItems(items, target) : (await copyLibraryFiles(items as LibraryFile[], target.id!, target.name)) > 0;
      if (ok) {
        onDone();
        onClose();
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{action === "copy" ? `Copy ${plural(items.length)}` : `Move ${plural(items.length)}`}</DialogTitle>
          <DialogDescription>
            {action === "copy" ? "Copies keep the original files where they are." : "Share links to moved files keep working."}
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Find a folder" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a folder" />
        </div>
        <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border p-1" role="listbox" aria-label="Folders">
          {action === "move" && onlyFolders && currentFolderId !== null && !filter ? (
            <FolderOptionRow icon={<Home className="size-4" />} label="Library (top level)" selected={target?.id === null} onSelect={() => setTarget({ id: null, name: "Library" })} />
          ) : null}
          {options.isInitialLoading ? (
            <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading folders…</p>
          ) : shown.length ? (
            shown.map((o) => (
              <FolderOptionRow
                key={o.id}
                icon={<Folder className="size-4 text-zinc-300" />}
                label={o.path}
                disabled={blocked(o)}
                selected={target?.id === o.id}
                onSelect={() => setTarget({ id: o.id, name: o.path.split(" / ").pop() ?? o.path })}
              />
            ))
          ) : (
            <p className="p-3 text-sm text-muted-foreground">No folders match.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button onClick={() => void confirm()} disabled={pending || !target}>
            {pending ? <Loader2 className="animate-spin" /> : null}
            {action === "copy" ? "Copy here" : "Move here"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FolderOptionRow({ icon, label, selected, disabled, onSelect }: {
  icon: React.ReactNode; label: string; selected: boolean; disabled?: boolean; onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
        selected ? "bg-white/10 text-foreground ring-1 ring-white/30" : "hover:bg-white/[0.06]",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}
