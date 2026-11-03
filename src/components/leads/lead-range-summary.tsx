"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/common/badges";
import { ErrorState } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { StaffSelect } from "@/components/leads/staff-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { useLiveQuery } from "@/hooks/use-live-query";
import { LEAD_TEMPERATURES } from "@/lib/constants";
import { fetchLeadRangeSummary, type LeadQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { previewLeadRangeReassign, reassignLeadRange } from "@/server/actions/leads";

/** Two taps on the same Sl No within this time count as a double-tap (iOS doesn't fire dblclick reliably). */
const DOUBLE_TAP_MS = 300;
const MAX_RANGE = 10_000;
/** At most this many rows are reassigned at once (reassign_lead_range). */
export const MAX_REASSIGN = 1_000;
const HINT_TOAST = "sl-range-start";

type Temp = (typeof LEAD_TEMPERATURES)[number] | "none";
const TEMP_SHORT: Record<Temp, string> = { hot: "Hot", medium: "Medium", cold: "Cold", none: "Not set" };
const TEMP_DOT: Record<Temp, string> = { hot: "bg-red-400", medium: "bg-amber-400", cold: "bg-sky-400", none: "bg-zinc-500" };

/** What the Sl Nos point at: the list's filters and sort, not the page (a range may span pages). */
export const rangeScope = (q: LeadQuery) => JSON.stringify({ ...q, page: undefined });

/** reassigning: the Reassign dialog for the range is open (outside the popover, which a dialog click would close). */
type Selection = { scope: string; anchor: number | null; range: [number, number] | null; openAt: number | null; reassigning?: boolean };

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
    if (!active || current.reassigning) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSel({ scope, anchor: null, range: null, openAt: null }); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, scope, current.reassigning]);

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

  const startReassign = () => setSel((s) => (s.scope === scope && s.range ? { ...s, openAt: null, reassigning: true } : s));
  const stopReassign = () => setSel((s) => (s.scope === scope ? { ...s, reassigning: false } : s));

  return {
    anchor: current.anchor, range: current.range, openAt: current.openAt, reassigning: !!current.reassigning && !!current.range,
    tap, inRange, clear, setOpen, startReassign, stopReassign,
  };
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
          <RangeSummary query={query} range={range.range!} onClear={range.clear} onReassign={range.startReassign} />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/** Rows a–b counted by stage and temperature (in the database, with the list's filters and sort). */
function RangeSummary({ query, range, onClear, onReassign }: { query: LeadQuery; range: [number, number]; onClear: () => void; onReassign: () => void }) {
  const profile = useProfile();
  const isAdmin = profile.role === "admin";
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
          {isAdmin && d.count && !query.archived ? (
            <div className="border-t pt-2">
              <Button size="sm" variant="outline" className="w-full" onClick={onReassign} disabled={d.count > MAX_REASSIGN}>
                <UserPlus />Reassign {d.count} {d.count === 1 ? "lead" : "leads"}
              </Button>
              {d.count > MAX_REASSIGN ? <p className="mt-1 text-xs text-muted-foreground">Up to {MAX_REASSIGN.toLocaleString("en-IN")} rows at a time. Pick a smaller range.</p> : null}
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">Click a highlighted number to see this again. Counted by position in this list.</p>
        </div>
      )}
    </div>
  );
}

/**
 * Reassign the selected Sl No range to one owner. Picking the owner shows a preview (how many move, from whom);
 * the preview's fingerprint goes with the confirm, so if the list shifted meanwhile nothing moves and the preview
 * is read again. Rendered once by the Leads list, for admins.
 */
export function RangeReassignDialog({ range, query, onDone }: { range: SlRange; query: LeadQuery; onDone: () => void }) {
  const profile = useProfile();
  const open = range.reassigning;
  const r = range.range;
  const [owner, setOwner] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = () => { if (!pending) { range.stopReassign(); setOwner(null); } };

  const preview = useLiveQuery({
    queryKey: `lead-range-reassign:${profile.id}:${rangeScope(query)}:${r?.join("-")}:${owner}`,
    // The action's result is the data (its error text is already readable); only a failed request throws.
    fetcher: () => previewLeadRangeReassign({ query, from: r![0], to: r![1], ownerId: owner! }),
    tables: ["leads"],
    enabled: open && !!r && !!owner,
    pollMs: 0,
  });
  const res = owner ? preview.data : undefined;
  const p = res?.ok && !preview.isStale ? res.data : null;
  const failed = res && !res.ok ? res.error : owner ? preview.error : null;

  const confirm = () => start(async () => {
    if (!p || !r || !owner) return;
    const done = await reassignLeadRange({ query, from: r[0], to: r[1], ownerId: owner, fingerprint: p.fingerprint });
    if (!done.ok) {
      toast.error(done.error);
      preview.refetch();
      return;
    }
    toast.success(`${done.data.moved} ${done.data.moved === 1 ? "lead" : "leads"} reassigned`);
    setOwner(null);
    range.clear();
    onDone();
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reassign rows {r?.[0]}–{r?.[1]}</DialogTitle>
          <DialogDescription>Pending follow-ups and reminders move to the new owner. Previous owners lose access.</DialogDescription>
        </DialogHeader>
        <StaffSelect value={owner} onChange={setOwner} placeholder="Select new owner" ariaLabel="New owner" />
        <div className="min-h-16 text-sm" role="status" aria-live="polite">
          {!owner ? (
            <p className="text-muted-foreground">Pick who should own these leads to see what will change.</p>
          ) : failed ? (
            <p className="text-destructive">{failed}</p>
          ) : !p ? (
            <div className="space-y-2"><Skeleton className="h-5 w-full" /><Skeleton className="h-5 w-2/3" /></div>
          ) : (
            <div className="space-y-2">
              <p>
                <span className="font-medium">{p.count} {p.count === 1 ? "lead" : "leads"}</span> in this range.{" "}
                <span className="font-medium">{p.moving}</span> will move
                {p.already_owned ? <span className="text-muted-foreground">; {p.already_owned} already belong to this owner</span> : null}.
              </p>
              {p.by_owner.length ? (
                <ul className="space-y-1 rounded-md border p-2" aria-label="Moving from">
                  {p.by_owner.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-2 text-muted-foreground">
                      <span>From {o.display_name}</span>
                      <span className="font-semibold text-foreground tabular-nums">{o.count}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={pending}>Cancel</Button>
          <Button onClick={confirm} disabled={pending || !p || p.moving === 0}>
            {pending && <Loader2 className="animate-spin" />}
            {p ? `Reassign ${p.moving} ${p.moving === 1 ? "lead" : "leads"}` : "Reassign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
