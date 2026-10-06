"use client";

import { useState } from "react";
import { Pin, Star } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** Max pins per list; the database enforces the same limit. */
export const MAX_PINS = 10;

type ToggleAction = (input: { id: string; on: boolean }) => Promise<ActionResult<unknown>>;

/**
 * Optimistic on/off toggle. The optimistic value only applies while the server value it
 * was based on is unchanged, so a refetch or Realtime update always wins.
 */
function useOptimisticToggle(on: boolean, id: string, action: ToggleAction, onChanged?: () => void) {
  const [optimistic, setOptimistic] = useState<{ base: boolean; value: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const shown = optimistic && optimistic.base === on ? optimistic.value : on;

  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (pending) return;
    const next = !shown;
    setOptimistic({ base: on, value: next });
    setPending(true);
    const r = await action({ id, on: next });
    setPending(false);
    if (!r.ok) {
      setOptimistic(null);
      toast.error(r.error);
      return;
    }
    onChanged?.();
  };
  return { shown, pending, toggle };
}

export function StarButton({ id, starred, action, onChanged, className }: {
  id: string; starred: boolean; action: ToggleAction; onChanged?: () => void; className?: string;
}) {
  const { shown, pending, toggle } = useOptimisticToggle(starred, id, action, onChanged);
  const label = shown ? "Unstar" : "Star";
  return (
    <Button type="button" variant="ghost" size="icon-sm" className={className} onClick={toggle} disabled={pending}
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
    <Button type="button" variant="ghost" size="icon-sm" className={className} onClick={toggle} disabled={pending}
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
