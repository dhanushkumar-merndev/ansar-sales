"use client";

import { createContext, useContext, useId, useMemo, useState, useSyncExternalStore } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { ArrowUpDown, Check, FileText, Folder, FolderInput } from "lucide-react";
import { toast } from "sonner";
import { ItemContextMenu } from "@/components/library/context-menus";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LIBRARY_SORTS, type LibraryItem, type LibrarySort } from "@/lib/library-queries";
import { cn } from "@/lib/utils";
import { reorderLibraryItems } from "@/server/actions/library";

// ---------------------------------------------------------------------------
// Per-viewer sort preference (kept in this browser, shared by every folder).
// ---------------------------------------------------------------------------

const SORT_KEY = "library:sort";
const FIRST_KEY = "library:folders-first";
const CHANGE = "library-sort-change";

function read(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode / blocked storage: the choice just isn't remembered.
  }
  window.dispatchEvent(new Event(CHANGE));
}

function subscribe(cb: () => void) {
  window.addEventListener(CHANGE, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE, cb);
    window.removeEventListener("storage", cb);
  };
}

const isSort = (v: string | null): v is LibrarySort => !!v && v in LIBRARY_SORTS;

export function useLibrarySort() {
  const raw = useSyncExternalStore(subscribe, () => read(SORT_KEY), () => null);
  const first = useSyncExternalStore(subscribe, () => read(FIRST_KEY), () => null);
  return {
    sort: isSort(raw) ? raw : ("custom" as LibrarySort),
    foldersFirst: first !== "0",
    setSort: (s: LibrarySort) => write(SORT_KEY, s),
    setFoldersFirst: (on: boolean) => write(FIRST_KEY, on ? "1" : "0"),
  };
}

export function LibrarySortMenu({
  sort,
  foldersFirst,
  onSort,
  onFoldersFirst,
  showFoldersFirst = true,
}: {
  sort: LibrarySort;
  foldersFirst: boolean;
  onSort: (s: LibrarySort) => void;
  onFoldersFirst?: (on: boolean) => void;
  showFoldersFirst?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8.5 gap-1.5 border-white/[0.1] bg-[#1f1f1f]/80 text-xs font-normal" aria-label="Sort">
          <ArrowUpDown className="size-3.5 text-muted-foreground" />
          {LIBRARY_SORTS[sort].label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={sort} onValueChange={(v) => isSort(v) && onSort(v)}>
          {(Object.keys(LIBRARY_SORTS) as LibrarySort[]).map((k) => (
            <DropdownMenuRadioItem key={k} value={k} className="text-xs">
              {LIBRARY_SORTS[k].label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {showFoldersFirst && onFoldersFirst ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={foldersFirst} onCheckedChange={(c) => onFoldersFirst(c === true)} className="text-xs">
              Folders first
            </DropdownMenuCheckboxItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ArrangeHint(..._args: any[]) { // eslint-disable-line @typescript-eslint/no-unused-vars
  return null;
}

// ---------------------------------------------------------------------------
// Selection, long-press drag to rearrange, and drag-to-move onto folders.
// ---------------------------------------------------------------------------

export const itemKey = (i: Pick<LibraryItem, "kind" | "id">) => `${i.kind}:${i.id}`;

/** "reorder": drag changes the custom order. "move": drag drops items onto folders. */
export type LibraryDndMode = "reorder" | "move" | "off";
/** Where items can be dropped: a folder, or the top level (id null, folders only). */
export type DropTarget = { id: string | null; name: string };

// The click that ends a drag must not open the folder or file underneath.
let lastDragEnd = 0;
const justDragged = () => Date.now() - lastDragEnd < 300;

/** Selected items of the current view; cleared whenever `scope` (folder, page, filters) changes. */
export function useLibrarySelection(scope: string) {
  const [state, setState] = useState({ scope, selecting: false, items: [] as LibraryItem[] });
  let cur = state;
  if (state.scope !== scope) {
    cur = { scope, selecting: state.selecting, items: [] };
    setState(cur);
  }
  const keys = useMemo(() => new Set(cur.items.map(itemKey)), [cur.items]);
  return {
    selecting: cur.selecting,
    items: cur.items,
    has: (key: string) => keys.has(key),
    setSelecting: (on: boolean) => setState((s) => ({ ...s, selecting: on, items: on ? s.items : [] })),
    toggle: (item: LibraryItem) =>
      setState((s) => {
        const k = itemKey(item);
        const exists = s.items.some((i) => itemKey(i) === k);
        return { ...s, selecting: true, items: exists ? s.items.filter((i) => itemKey(i) !== k) : [...s.items, item] };
      }),
    selectAll: (items: LibraryItem[]) => setState((s) => ({ ...s, selecting: true, items })),
    clear: () => setState((s) => ({ ...s, items: [] })),
  };
}
export type LibrarySelection = ReturnType<typeof useLibrarySelection>;

/**
 * Optimistic custom order for one page. `arrange(group)` takes the new order of
 * some of the page's items (all of them, or just the folders / just the files)
 * and saves it; on failure the server order comes back.
 */
export function useLibraryArrange(parentId: string | null, items: LibraryItem[], onSaved: () => void) {
  const [override, setOverride] = useState<{ base: LibraryItem[]; items: LibraryItem[] } | null>(null);
  const shown = override && override.base === items ? override.items : items;

  async function arrange(group: LibraryItem[]) {
    const wanted = new Set(group.map(itemKey));
    const queue = [...group];
    const next = shown.map((i) => (wanted.has(itemKey(i)) ? queue.shift()! : i));
    setOverride({ base: items, items: next });
    const r = await reorderLibraryItems({ parentId, items: group.map(({ kind, id }) => ({ kind, id })) });
    if (!r.ok) {
      toast.error(r.error);
      setOverride(null);
    }
    onSaved();
  }

  return { items: shown, arrange };
}

type DndState = { mode: LibraryDndMode; selection: LibrarySelection | null; dragging: Set<string> | null };
const DndCtx = createContext<DndState>({ mode: "off", selection: null, dragging: null });
const GroupCtx = createContext<{ id: string; items: LibraryItem[]; layout: "grid" | "list" } | null>(null);

/** Wraps a whole view: every SortableItem, SortableArea and DropTargetLink inside takes part. */
export function LibraryDnd({ mode, selection, onArrange, onMove, children }: {
  mode: LibraryDndMode;
  selection: LibrarySelection;
  onArrange: (group: LibraryItem[]) => void;
  onMove: (items: LibraryItem[], target: DropTarget) => void;
  children: React.ReactNode;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { delay: 350, tolerance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 8 } }),
  );
  const [dragging, setDragging] = useState<LibraryItem[] | null>(null);
  // Size of the picked-up card, so the floating copy matches it while rearranging.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const draggingKeys = useMemo(() => (dragging ? new Set(dragging.map(itemKey)) : null), [dragging]);
  const state = useMemo(() => ({ mode, selection, dragging: draggingKeys }), [mode, selection, draggingKeys]);

  // Drop targets (folders, breadcrumbs) win when the pointer is over one; otherwise reordering uses the nearest item.
  const collision: CollisionDetection = (args) => {
    const targets = pointerWithin(args).filter((c) => args.droppableContainers.find((d) => d.id === c.id)?.data.current?.target);
    if (targets.length) return targets;
    return mode === "reorder" ? closestCenter(args) : [];
  };

  function onDragStart(e: DragStartEvent) {
    const item = e.active.data.current?.item as LibraryItem | undefined;
    if (!item) return;
    // Dragging a selected item takes the whole selection along.
    setDragging(selection.has(itemKey(item)) ? selection.items : [item]);
    const rect = e.active.rect.current.initial;
    setSize(rect ? { width: rect.width, height: Math.min(rect.height, 240) } : null);
  }

  function onDragEnd(e: DragEndEvent) {
    lastDragEnd = Date.now();
    const moving = dragging;
    setDragging(null);
    const target = e.over?.data.current?.target as DropTarget | undefined;
    if (target && moving) {
      if (!moving.some((i) => i.kind === "folder" && i.id === target.id)) onMove(moving, target);
      return;
    }
    if (mode !== "reorder" || !e.over || e.active.id === e.over.id) return;
    const a = e.active.data.current;
    const o = e.over.data.current;
    if (!a || !o || a.group !== o.group) return;
    const items = a.groupItems as LibraryItem[];
    const ids = items.map(itemKey);
    const from = ids.indexOf(String(e.active.id));
    const to = ids.indexOf(String(e.over.id));
    if (from >= 0 && to >= 0) onArrange(arrayMove(items, from, to));
  }

  if (mode === "off") return <DndCtx.Provider value={state}>{children}</DndCtx.Provider>;
  return (
    <DndCtx.Provider value={state}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        // Only scroll up and down: sideways auto-scroll used to drag the whole page off screen.
        autoScroll={{ threshold: { x: 0, y: 0.15 } }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => { lastDragEnd = Date.now(); setDragging(null); }}
      >
        {children}
        {/* The dragged item floats above the page (position: fixed), so it never widens or shifts the layout. */}
        <DragOverlay dropAnimation={null}>
          {!dragging ? null : mode === "move" ? (
            <div className="flex w-max items-center gap-2 rounded-lg border border-white/20 bg-[#1f1f1f] px-3 py-2 text-xs font-medium text-foreground shadow-2xl">
              <FolderInput className="size-4 text-zinc-300" />
              {dragging.length === 1 ? `Move “${dragging[0].name}”` : `Move ${dragging.length} items`}
            </div>
          ) : (
            <div
              style={size ?? undefined}
              className="flex cursor-grabbing flex-col items-center justify-center gap-2 rounded-xl border border-white/25 bg-[#262626] p-3 text-center shadow-2xl"
            >
              {dragging[0].kind === "folder" ? <Folder className="size-6 text-zinc-300" /> : <FileText className="size-6 text-zinc-300" />}
              <span className="max-w-full truncate text-sm font-medium">{dragging[0].name}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </DndCtx.Provider>
  );
}

/** A group of items that are rearranged among themselves (all items, or just folders / just files). */
export function SortableArea({ items, layout = "grid", children }: { items: LibraryItem[]; layout?: "grid" | "list"; children: React.ReactNode }) {
  const id = useId();
  const { mode } = useContext(DndCtx);
  const group = useMemo(() => ({ id, items, layout }), [id, items, layout]);
  return (
    <GroupCtx.Provider value={group}>
      {mode === "reorder" ? (
        <SortableContext id={id} items={items.map(itemKey)} strategy={layout === "grid" ? rectSortingStrategy : verticalListSortingStrategy}>
          {children}
        </SortableContext>
      ) : children}
    </GroupCtx.Provider>
  );
}

/** Wraps one card or row: selection, long-press drag, and (for folders) dropping items onto it. */
export function SortableItem({ item, className, children }: { item: LibraryItem; className?: string; children: React.ReactNode }) {
  const { mode } = useContext(DndCtx);
  // Right-click menu (only inside a LibraryActionsProvider).
  const content = <ItemContextMenu item={item}>{children}</ItemContextMenu>;
  if (mode === "reorder") return <ReorderShell item={item} className={className}>{content}</ReorderShell>;
  if (mode === "move") return <MoveShell item={item} className={className}>{content}</MoveShell>;
  return <div className={className}>{content}</div>;
}

function useShellProps(item: LibraryItem) {
  const { selection } = useContext(DndCtx);
  const layout = useContext(GroupCtx)?.layout ?? "grid";
  const key = itemKey(item);
  const selected = !!selection?.has(key);
  return {
    selected,
    badge: selection?.selecting ? (
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute z-30 flex size-5 items-center justify-center rounded-full border-2 shadow",
          layout === "grid" ? "-top-1.5 -left-1.5" : "top-1/2 left-0.5 -translate-y-1/2",
          selected ? "border-white bg-white text-black" : "border-white/40 bg-[#1f1f1f]",
        )}
      >
        {selected ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
    ) : null,
    props: {
      "aria-selected": selection?.selecting ? selected : undefined,
      // In select mode (or with Ctrl/⌘) a click selects instead of opening.
      onClickCapture: (e: React.MouseEvent) => {
        if (!fromInside(e)) return;
        if (justDragged() || selection?.selecting || e.metaKey || e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          if (!justDragged() && selection) selection.toggle(item);
        }
      },
      // A long press on a phone would otherwise open the link/image menu instead of picking the item up.
      onContextMenu: (e: React.MouseEvent) => {
        if (fromInside(e) && (e.nativeEvent as PointerEvent).pointerType === "touch") e.preventDefault();
      },
    },
  };
}

const shellBase = "relative select-none [-webkit-touch-callout:none]";

// Menus and dialogs opened from a card render in portals, but React still bubbles their
// events to the card's wrapper. Only events from the card's own DOM may select or drag it.
const fromInside = (e: React.SyntheticEvent) => e.currentTarget.contains(e.target as Node);
function ownListeners(listeners: SyntheticListenerMap | undefined) {
  if (!listeners) return {};
  return Object.fromEntries(
    Object.entries(listeners).map(([name, fn]) => [name, (e: React.SyntheticEvent) => { if (fromInside(e)) fn(e); }]),
  );
}

function ReorderShell({ item, className, children }: { item: LibraryItem; className?: string; children: React.ReactNode }) {
  const group = useContext(GroupCtx);
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: itemKey(item),
    data: { item, group: group?.id, groupItems: group?.items ?? [] },
  });
  const { selected, badge, props } = useShellProps(item);
  return (
    <div
      ref={setNodeRef}
      {...ownListeners(listeners)}
      {...props}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        shellBase,
        selected && "rounded-xl ring-2 ring-white/50",
        // The original stays in its (new) slot as a placeholder while the floating copy follows the pointer.
        isDragging && "rounded-xl opacity-30 outline-2 outline-dashed outline-white/50",
        className,
      )}
    >
      {badge}
      {children}
    </div>
  );
}

function MoveShell({ item, className, children }: { item: LibraryItem; className?: string; children: React.ReactNode }) {
  const { dragging } = useContext(DndCtx);
  const key = itemKey(item);
  const beingDragged = !!dragging?.has(key);
  const drag = useDraggable({ id: key, data: { item } });
  const drop = useDroppable({
    id: `drop:${item.id}`,
    data: { target: { id: item.id, name: item.name } satisfies DropTarget },
    disabled: item.kind !== "folder" || beingDragged || !!item.archived_at,
  });
  const { selected, badge, props } = useShellProps(item);
  const over = drop.isOver && !!dragging;
  return (
    <div
      ref={(n) => { drag.setNodeRef(n); drop.setNodeRef(n); }}
      {...ownListeners(drag.listeners)}
      {...props}
      className={cn(
        shellBase,
        selected && "rounded-xl ring-2 ring-white/50",
        beingDragged && "opacity-40",
        over && "rounded-xl ring-2 ring-emerald-400",
        className,
      )}
    >
      {badge}
      {over ? (
        <span className="pointer-events-none absolute inset-x-0 -top-3 z-30 mx-auto w-max rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-semibold text-black shadow">
          Move into {item.name}
        </span>
      ) : null}
      {children}
    </div>
  );
}

/** A breadcrumb (or other link to a folder) that items can be dropped onto while dragging. */
export function DropTargetLink({ target, children }: { target: DropTarget; children: React.ReactNode }) {
  const { mode } = useContext(DndCtx);
  if (mode === "off") return <>{children}</>;
  return <ActiveDropTarget target={target}>{children}</ActiveDropTarget>;
}

function ActiveDropTarget({ target, children }: { target: DropTarget; children: React.ReactNode }) {
  const { dragging } = useContext(DndCtx);
  const { setNodeRef, isOver } = useDroppable({ id: `crumb:${target.id ?? "root"}`, data: { target } });
  return (
    <span
      ref={setNodeRef}
      onClickCapture={(e) => {
        if (justDragged()) { e.preventDefault(); e.stopPropagation(); }
      }}
      className={cn("rounded-md transition-colors", dragging && "outline-1 outline-dashed outline-white/20", isOver && dragging && "bg-emerald-500/20 outline-emerald-400")}
    >
      {children}
    </span>
  );
}
