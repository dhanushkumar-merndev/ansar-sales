"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pin, Star } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** Max pins per list; the database enforces the same limit. */
export const MAX_PINS = 10;

type ToggleAction = (input: { id: string; on: boolean }) => Promise<ActionResult<unknown>>;

/** Quick clicks within this window are merged into one save (star → unstar sends nothing). */
const SAVE_DEBOUNCE_MS = 600;

/**
 * Optimistic on/off toggle: the icon flips on click and the button stays clickable.
 * The save is debounced and only the final wanted value is sent; leaving the page sends it at once.
 * The optimistic value only applies while the server value it was based on is unchanged,
 * so a refetch or Realtime update always wins.
 */
function useOptimisticToggle(on: boolean, id: string, action: ToggleAction, onChanged?: () => void) {
  const [optimistic, setOptimistic] = useState<{ base: boolean; value: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const wanted = useRef<boolean | null>(null);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ on, id, action, onChanged });
  useEffect(() => {
    latest.current = { on, id, action, onChanged };
  });
  // Once the server value moves, the optimistic guess is spent; never let it come back later.
  if (optimistic && optimistic.base !== on) setOptimistic(null);
  const shown = optimistic && optimistic.base === on ? optimistic.value : on;

  const save = useCallback(async () => {
    timer.current = null;
    if (saving.current) return; // the running save picks up the newest wanted value
    saving.current = true;
    let sent: boolean = latest.current.on;
    let changed = false;
    while (wanted.current !== null && wanted.current !== sent) {
      setPending(true);
      const value: boolean = wanted.current;
      const r = await latest.current.action({ id: latest.current.id, on: value });
      if (!r.ok) {
        setOptimistic(null);
        toast.error(r.error);
        changed = true; // resync with whatever the server has now
        break;
      }
      sent = value;
      changed = true;
    }
    wanted.current = null;
    saving.current = false;
    setPending(false);
    if (changed) latest.current.onChanged?.();
  }, []);

  // Leaving the page mid-debounce saves immediately instead of dropping the click.
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      void save();
    }
  }, [save]);

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !shown;
    setOptimistic({ base: on, value: next });
    wanted.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  };
  return { shown, pending, toggle };
}

export function StarButton({ id, starred, action, onChanged, className }: {
  id: string; starred: boolean; action: ToggleAction; onChanged?: () => void; className?: string;
}) {
  const { shown, pending, toggle } = useOptimisticToggle(starred, id, action, onChanged);
  const label = shown ? "Unstar" : "Star";
  return (
    <Button type="button" variant="ghost" size="icon-sm" className={className} onClick={toggle} aria-busy={pending}
      aria-pressed={shown} aria-label={label} title={label}>
      <Star className={cn("size-4", shown ? "fill-amber-400 text-amber-500" : "text-muted-foreground")} />
    </Button>
  );
}

export function PinButton({ id, pinned, action, onChanged, className }: {
  id: string; pinned: boolean; action: ToggleAction; onChanged?: () => void; className?: string;
}) {
  const { shown, pending, toggle } = useOptimisticToggle(pinned, id, action, onChanged);
  const label = shown ? "Unpin" : "Pin to top";
  return (
    <Button type="button" variant="ghost" size="icon-sm" className={className} onClick={toggle} aria-busy={pending}
      aria-pressed={shown} aria-label={label} title={label}>
      <Pin className={cn("size-4", shown ? "fill-foreground text-foreground" : "text-muted-foreground")} />
    </Button>
  );
}

export function PinnedBadge() {
  return <Badge variant="outline" className="gap-1 font-normal"><Pin className="size-3" /> Pinned</Badge>;
}

export function PinnedCount({ count }: { count: number }) {
  return (
    <span className={cn("text-xs text-muted-foreground", count >= MAX_PINS && "font-medium text-foreground")}>
      Pinned {Math.min(count, MAX_PINS)}/{MAX_PINS}
    </span>
  );
}
