"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/common/badges";
import { ErrorState } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveQuery } from "@/hooks/use-live-query";
import { LEAD_TEMPERATURES } from "@/lib/constants";
import { fetchLeadRangeSummary, type LeadQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** Two taps on the same Sl No within this time count as a double-tap (iOS doesn't fire dblclick reliably). */
const DOUBLE_TAP_MS = 300;
const MAX_RANGE = 10_000;
const HINT_TOAST = "sl-range-start";

type Temp = (typeof LEAD_TEMPERATURES)[number] | "none";
const TEMP_SHORT: Record<Temp, string> = { hot: "Hot", medium: "Medium", cold: "Cold", none: "Not set" };
const TEMP_DOT: Record<Temp, string> = { hot: "bg-red-400", medium: "bg-amber-400", cold: "bg-sky-400", none: "bg-zinc-500" };

/** What the Sl Nos point at: the list's filters and sort, not the page (a range may span pages). */
export const rangeScope = (q: LeadQuery) => JSON.stringify({ ...q, page: undefined });

type Selection = { scope: string; anchor: number | null; range: [number, number] | null; openAt: number | null };

/**
 * Sl No range selection on the Leads list. Double-click (or double-tap) a Sl No to mark the start, then another
 * to pick the range: its summary opens beside that number. One click on a highlighted number opens it again;
 * the start again clears the mark. Kept as numbers so it survives page changes; cleared when the filters or
 * sort change (the numbers would then point at other leads) and on Esc.
 */
export function useSlRange(query: LeadQuery) {
  const scope = rangeScope(query);
  const empty: Selection = { scope, anchor: null, range: null, openAt: null };
  const [sel, setSel] = useState<Selection>(empty);
  const current = sel.scope === scope ? sel : empty;
  const lastTap = useRef<{ sl: number; at: number } | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => setSel(empty);
  const active = current.anchor !== null || current.range !== null;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSel({ scope, anchor: null, range: null, openAt: null }); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, scope]);

  // The "From #n" hint lives in a toast so it stays visible on other pages; it goes once the mark does.
  useEffect(() => {
    if (current.anchor === null) {
      toast.dismiss(HINT_TOAST);
      return;
    }
    toast(`From #${current.anchor}`, {
      id: HINT_TOAST,
      description: "Double-click another Sl No to select the range (you can change page first). Esc cancels.",
      duration: Infinity,
      action: { label: "Cancel", onClick: () => setSel({ scope, anchor: null, range: null, openAt: null }) },
    });
  }, [current.anchor, scope]);
  useEffect(() => () => {
    toast.dismiss(HINT_TOAST);
    if (openTimer.current) clearTimeout(openTimer.current);
  }, []);

  const pick = (sl: number) => {
    const { anchor } = current;
    if (anchor === null) setSel({ scope, anchor: sl, range: null, openAt: null });
    else if (anchor === sl) setSel(empty);
    else {
      const a = Math.min(anchor, sl), b = Math.max(anchor, sl);
      setSel({ scope, anchor: null, range: [a, Math.min(b, a + MAX_RANGE - 1)], openAt: sl });
    }
  };

  const inRange = (sl: number) => current.anchor === sl || (!!current.range && sl >= current.range[0] && sl <= current.range[1]);

  /** Click on a Sl No: a second click on the same number within DOUBLE_TAP_MS picks it; a single click on a
   *  highlighted number (once no second click follows) reopens the summary there. */
  const tap = (sl: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (openTimer.current) clearTimeout(openTimer.current);
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && prev.sl === sl && now - prev.at < DOUBLE_TAP_MS) {
      lastTap.current = null;
      pick(sl);
      return;
    }
    lastTap.current = { sl, at: now };
    if (current.range && inRange(sl)) {
      openTimer.current = setTimeout(() => setSel((s) => (s.scope === scope && s.range ? { ...s, openAt: sl } : s)), DOUBLE_TAP_MS);
    }
  };

  const setOpen = (sl: number, open: boolean) => setSel((s) => (s.scope !== scope ? s : { ...s, openAt: open ? sl : s.openAt === sl ? null : s.openAt }));

  return { anchor: current.anchor, range: current.range, openAt: current.openAt, tap, inRange, clear, setOpen };
}

export type SlRange = ReturnType<typeof useSlRange>;

/** The Sl No cell / chip, with the range summary opening beside it. */
export function SlNo({ sl, range, query, side = "right", className }: {
  sl: number; range: SlRange; query: LeadQuery; side?: "right" | "bottom"; className?: string;
}) {
  const selected = range.inRange(sl);
  const open = range.openAt === sl && !!range.range;
  return (
    <Popover open={open} onOpenChange={(o) => range.setOpen(sl, o)}>
      <PopoverAnchor asChild>
        <button
          type="button"
          onClick={(e) => range.tap(sl, e)}
          onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          title="Double-click to select a range"
          aria-pressed={selected}
          aria-label={`Sl No ${sl}. Double-click to select a range`}
          className={cn(
            "min-w-8 rounded px-1.5 py-0.5 text-right text-xs tabular-nums text-muted-foreground select-none hover:bg-white/[0.06]",
            selected && "bg-red-500/15 font-medium text-red-200",
            className,
          )}
        >
          {sl}
        </button>
      </PopoverAnchor>
      {open ? (
        <PopoverContent side={side} align="start" className="w-80" onOpenAutoFocus={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}>
          <RangeSummary query={query} range={range.range!} onClear={range.clear} />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/** Rows a–b counted by stage and temperature (in the database, with the list's filters and sort). */
function RangeSummary({ query, range, onClear }: { query: LeadQuery; range: [number, number]; onClear: () => void }) {
  const profile = useProfile();
  const summary = useLiveQuery({
    queryKey: `lead-range:${profile.id}:${rangeScope(query)}:${range.join("-")}`,
    fetcher: (s) => fetchLeadRangeSummary(query, range[0], range[1], s),
    tables: ["leads", "lead_stars", "follow_ups"],
    keep: true,
  });
  const d = summary.data;

  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">
          Rows {range[0]}–{range[1]}
          {d ? <span className="text-muted-foreground"> · {d.count} {d.count === 1 ? "lead" : "leads"}</span> : null}
        </p>
        <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1" onClick={onClear} aria-label="Clear the selection" title="Clear the selection"><X /></Button>
      </div>
      {summary.error && !d ? (
        <ErrorState message={summary.error} onRetry={summary.refetch} />
      ) : !d ? (
        <div className="space-y-2"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-2/3" /></div>
      ) : (
        <div className={cn("space-y-3", summary.isStale && "opacity-60")}>
          {d.stages.length ? (
            <ul className="space-y-1.5" aria-label="By stage">
              {d.stages.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2">
                  <StatusBadge stageId={s.id} status={s.kind} />
                  <span className="text-sm font-semibold tabular-nums">{s.count}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No leads in this range.</p>}
          {d.count ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 border-t pt-2 text-sm" aria-label="By temperature">
              {([...LEAD_TEMPERATURES, "none"] as const).map((t) => (
                <span key={t} className="flex items-center justify-between gap-1.5 text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5"><span className={cn("size-2 rounded-full", TEMP_DOT[t])} aria-hidden />{TEMP_SHORT[t]}</span>
                  <span className="font-semibold text-foreground tabular-nums">{d.temperatures[t]}</span>
                </span>
              ))}
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">Click a highlighted number to see this again. Counted by position in this list.</p>
        </div>
      )}
    </div>
  );
}
