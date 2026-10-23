"use client";

import { useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Ban, Check, GripVertical, Palette, PhoneCall, StickyNote } from "lucide-react";
import { toast } from "sonner";
import { COLOR_NAMES } from "@/components/common/color-swatch-picker";
import { ScrollBox } from "@/components/common/scroll-box";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { forLead, useLiveQuery } from "@/hooks/use-live-query";
import { parseFormAnswers } from "@/lib/form-answers";
import { CALL_OUTCOMES, type CallOutcome } from "@/lib/library";
import { fetchLeadNotes, type LeadNote } from "@/lib/queries";
import { STAGE_COLORS, STAGE_HEX, type StageColor } from "@/lib/stages";
import { formatDateTime, formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";
import { reorderLeadNotes, setLeadNoteColor } from "@/server/actions/leads";

/**
 * The lead's notes and call notes beside the call screen as cards (three a row on wide screens), newest unsorted ones first.
 * Drag the handle (or focus it and use Space + arrow keys) to put them in any order; the order is
 * saved for the lead, so everyone who can see it gets the same list.
 */
export function CallNotes({ leadId, className }: { leadId: string; className?: string }) {
  const profile = useProfile();
  const notes = useLiveQuery({
    queryKey: `lead-notes:${profile.id}:${leadId}`,
    fetcher: (s) => fetchLeadNotes(leadId, s),
    tables: ["lead_activities", "leads"],
    match: forLead(leadId),
  });
  // The dragged order, shown until the server's list catches up.
  const [order, setOrder] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [seen, setSeen] = useState(notes.data);
  if (seen !== notes.data) {
    setSeen(notes.data);
    if (!saving) setOrder(null);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byId = new Map((notes.data ?? []).map((n) => [n.id, n]));
  const items = order
    ? [...(notes.data ?? []).filter((n) => !order.includes(n.id)), ...order.flatMap((id) => byId.get(id) ?? [])]
    : (notes.data ?? []);

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = items.map((n) => n.id);
    const next = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    setOrder(next);
    setSaving(true);
    const r = await reorderLeadNotes({ leadId, ids: next });
    setSaving(false);
    if (!r.ok) {
      setOrder(null); // back to the saved order
      toast.error(r.error);
      return;
    }
    notes.refetch();
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Previous notes</h3>
        {items.length > 1 ? <span className="text-xs text-muted-foreground">Drag to reorder</span> : null}
      </div>
      {notes.isInitialLoading ? (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3"><Skeleton className="h-44" /><Skeleton className="h-44" /><Skeleton className="h-44" /></div>
      ) : notes.error && !notes.data ? (
        <p className="py-8 text-center text-xs text-muted-foreground">Couldn&apos;t load notes. {notes.error}</p>
      ) : items.length === 0 ? (
        <p className="rounded-md border border-dashed py-10 text-center text-xs text-muted-foreground">No notes yet.</p>
      ) : (
        <ScrollBox label="Previous notes" className="min-h-0 flex-1">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onDragEnd(e)}>
            <SortableContext items={items.map((n) => n.id)} strategy={rectSortingStrategy}>
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {items.map((n) => <NoteCard key={n.id} leadId={leadId} note={n} disabled={saving} onChanged={notes.refetch} />)}
              </ul>
            </SortableContext>
          </DndContext>
        </ScrollBox>
      )}
    </div>
  );
}

/** Who wrote it, what kind of entry, and when. */
function NoteMeta({ note }: { note: LeadNote }) {
  const isCall = note.type === "call_logged";
  const outcome = isCall ? CALL_OUTCOMES[note.meta?.outcome as CallOutcome] : undefined;
  const Icon = isCall ? PhoneCall : StickyNote;
  return (
    <>
      <span className="inline-flex items-center gap-1">
        <Icon className="size-3" />
        <span className="font-medium text-foreground">{note.actor?.display_name ?? "System"}</span>
        {isCall ? <span>· Call{outcome ? ` · ${outcome}` : ""}{typeof note.meta?.duration_seconds === "number" ? ` · ${formatDuration(note.meta.duration_seconds)}` : ""}</span> : null}
        {note.edited_at ? <span>· edited</span> : null}
      </span>
      <time dateTime={note.created_at}>{formatDateTime(note.created_at)}</time>
    </>
  );
}

function NoteBody({ note, className }: { note: LeadNote; className?: string }) {
  const answers = note.actor ? null : parseFormAnswers(note.body);
  if (!answers) return <p className={cn("break-words whitespace-pre-wrap", className)}>{note.body}</p>;
  return (
    <dl className={cn("space-y-1.5", className)}>
      {answers.map((x, i) => (
        <div key={i}>
          {x.question ? <dt className="text-xs text-muted-foreground">{x.question}</dt> : null}
          <dd className="whitespace-pre-wrap">{x.answer}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A tinted background and border for a coloured card (hex with alpha). */
const tint = (color: StageColor | null | undefined) =>
  color ? { background: `${STAGE_HEX[color]}1f`, borderColor: `${STAGE_HEX[color]}80` } : undefined;

/** A note card: long text is cut off here, and clicking the card shows all of it in a large window. */
function NoteCard({ leadId, note, disabled, onChanged }: { leadId: string; note: LeadNote; disabled: boolean; onChanged: () => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: note.id, disabled });
  const [open, setOpen] = useState(false);
  // The picked colour, shown until the server's list catches up.
  const [picked, setPicked] = useState<StageColor | null | undefined>(undefined);
  const [seenColor, setSeenColor] = useState(note.color);
  if (seenColor !== note.color) {
    setSeenColor(note.color);
    setPicked(undefined);
  }
  const color = picked === undefined ? note.color : picked;

  const pick = async (next: StageColor | null) => {
    if (next === (color ?? null)) return;
    setPicked(next);
    const r = await setLeadNoteColor({ leadId, activityId: note.id, color: next });
    if (!r.ok) {
      setPicked(undefined); // back to the saved colour
      toast.error(r.error);
      return;
    }
    onChanged();
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, ...tint(color) }}
      className={cn("relative flex h-44 gap-2 rounded-md border bg-card p-2.5", isDragging && "z-10 shadow-lg")}
    >
      <div className="-ml-1 flex shrink-0 flex-col items-center gap-1">
        <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label="Drag to reorder"
        className="flex h-6 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
        </button>
        <NoteColorPicker value={color ?? null} onChange={(c) => void pick(c)} />
      </div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Open the full note"
        className="flex min-w-0 flex-1 cursor-pointer flex-col rounded text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs text-muted-foreground"><NoteMeta note={note} /></div>
        {/* Fades out at the bottom when the note is longer than the card. */}
        <div className="relative mt-1 min-h-0 flex-1 overflow-hidden text-sm [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
          <NoteBody note={note} />
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[calc(100svh-4rem)] flex-col sm:max-w-3xl" style={color ? { borderTop: `4px solid ${STAGE_HEX[color]}` } : undefined}>
          <DialogHeader>
            <DialogTitle>{note.type === "call_logged" ? "Call note" : "Note"}</DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs"><NoteMeta note={note} /></div>
            </DialogDescription>
          </DialogHeader>
          <ScrollBox label="Full note" className="min-h-0 flex-1">
            <NoteBody note={note} className="text-base leading-relaxed" />
          </ScrollBox>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** A small dot that opens the shared palette for a note card; "No colour" clears it. */
function NoteColorPicker({ value, onChange }: { value: StageColor | null; onChange: (c: StageColor | null) => void }) {
  const [open, setOpen] = useState(false);
  const choose = (c: StageColor | null) => { setOpen(false); onChange(c); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Card colour: ${value ? COLOR_NAMES[value] : "none"}`}
          title="Card colour"
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {value ? <span className="size-3 rounded-full" style={{ background: STAGE_HEX[value] }} /> : <Palette className="size-3.5" />}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="grid grid-cols-5 gap-1.5" role="listbox" aria-label="Card colour">
          {STAGE_COLORS.map((c) => (
            <button key={c} type="button" role="option" aria-selected={c === value} title={COLOR_NAMES[c]} onClick={() => choose(c)}
              className={cn("flex size-8 items-center justify-center rounded-md border border-transparent hover:border-border focus-visible:outline-2 focus-visible:outline-ring", c === value && "border-foreground/40")}>
              <span className="flex size-5 items-center justify-center rounded-full" style={{ background: STAGE_HEX[c] }}>
                {c === value ? <Check className="size-3 text-black/70" /> : null}
              </span>
            </button>
          ))}
          <button type="button" role="option" aria-selected={value === null} title="No colour" onClick={() => choose(null)}
            className={cn("flex size-8 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border focus-visible:outline-2 focus-visible:outline-ring", value === null && "border-foreground/40")}>
            <Ban className="size-4" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** All of a lead's notes full screen (the same cards as the call screen), from the Leads table or the lead page. */
export function LeadNotesDialog({ leadId, leadName, open, onOpenChange }: { leadId: string; leadName: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[calc(100svh-2rem)] flex-col sm:max-w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle>Notes · {leadName}</DialogTitle>
          <DialogDescription>Notes and call notes. Drag to reorder, pick a colour, or open one to read it all.</DialogDescription>
        </DialogHeader>
        {open ? <CallNotes leadId={leadId} className="flex-1" /> : null}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
