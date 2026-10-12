"use client";

import type { CSSProperties } from "react";
import { Check, Loader2 } from "lucide-react";
import { COLOR_NAMES } from "@/components/common/color-swatch-picker";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { FileComment } from "@/lib/projects";
import { STAGE_COLORS, STAGE_HEX, type StageColor } from "@/lib/stages";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

/** Older pins were saved with only a marker as their text. */
export const noteText = (body: string) => (body.trim() === "📍" ? "Pinned spot (no note written)" : body);

/** Whether a note is pinned to a spot (on a picture or on a drawing). */
export const isPinned = (c: FileComment) => (c.x_pct != null && c.y_pct != null) || c.cad_x != null;

/** Cards open towards the middle (x / y in percent of the frame), so they stay on the preview. */
export const pinSide = (x: number, y: number) => cn(x > 60 ? "right-1/2 mr-4" : "left-1/2 ml-4", y > 65 ? "bottom-1/2" : "top-1/2");

// The colour last picked for a new pin (per browser), so a run of notes on one drawing keeps the same one.
const COLOR_KEY = "pin-color";
export const lastPinColor = (): StageColor => {
  try { const v = window.localStorage.getItem(COLOR_KEY); return (STAGE_COLORS as readonly string[]).includes(v ?? "") ? (v as StageColor) : "red"; } catch { return "red"; }
};
export const rememberPinColor = (c: StageColor) => { try { window.localStorage.setItem(COLOR_KEY, c); } catch { /* not remembered */ } };

/**
 * The look of a pin: its picked colour (dark number, white edge and a thin dark ring so it shows on light and
 * dark drawings alike), else red (green for the client); faded once done.
 */
export function pinLook(c: Pick<FileComment, "pin_color" | "from_client" | "resolved_at">): { className: string; style?: CSSProperties } {
  if (c.resolved_at) return { className: "border-white/50 bg-white/30 text-white" };
  if (c.pin_color) return { className: "border-white text-black/85 shadow-[0_0_0_1.5px_rgba(0,0,0,0.55)]", style: { background: STAGE_HEX[c.pin_color] } };
  return { className: c.from_client ? "border-white bg-emerald-500 text-white" : "border-white bg-red-500 text-white" };
}

/** The palette as a row of dots (picking a pin's colour). */
export function PinColorDots({ value, onChange, disabled }: { value: StageColor | null; onChange: (c: StageColor) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Pin colour">
      {STAGE_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={c === value} title={COLOR_NAMES[c]} aria-label={COLOR_NAMES[c]} disabled={disabled} onClick={() => onChange(c)}
          className={cn("flex size-6 items-center justify-center rounded-full border-2 transition-transform hover:scale-110 disabled:opacity-50",
            c === value ? "border-foreground" : "border-transparent")}>
          <span className="flex size-4 items-center justify-center rounded-full" style={{ background: STAGE_HEX[c] }}>
            {c === value ? <Check className="size-3 text-black/75" /> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

/** A numbered pin; hover (or focus) shows its note. `style` places it, `x` / `y` (percent) pick the card's side. */
export function NotePin({ c, n, active, onActive, style, x, y }: {
  c: FileComment; n: number; active: boolean; onActive: (id: string | null) => void; style: CSSProperties; x: number; y: number;
}) {
  return (
    <div className="group absolute" style={style} onMouseEnter={() => onActive(c.id)} onMouseLeave={() => onActive(null)}>
      <button type="button" aria-label={`Note ${n}: ${c.body}`} onFocus={() => onActive(c.id)} onBlur={() => onActive(null)}
        onClick={(e) => { e.stopPropagation(); document.getElementById(`note-${c.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }}
        style={pinLook(c).style}
        className={cn("flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 text-[11px] font-bold shadow-md transition-transform",
          pinLook(c).className, active && "scale-125 ring-2 ring-white/70")}>
        {n}
      </button>
      <div role="tooltip" className={cn("pointer-events-none absolute z-20 w-60 rounded-lg border bg-popover p-2.5 text-left text-sm text-popover-foreground shadow-xl",
        pinSide(x, y), active ? "block" : "hidden group-hover:block")}>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{c.from_client ? "Client" : c.author}</span>· {formatRelative(c.created_at)}{c.resolved_at ? " · done" : ""}
        </div>
        <p className={cn("mt-1 whitespace-pre-wrap break-words", c.resolved_at && "line-through opacity-70")}>{noteText(c.body)}</p>
      </div>
    </div>
  );
}

/** The pin being placed: write the note right there (nothing is saved without text). */
export function PinDraft({ n, style, x, y, body, onBody, color, onColor, onSave, onCancel, pending }: {
  n: number; style: CSSProperties; x: number; y: number; body: string; onBody: (v: string) => void;
  color: StageColor; onColor: (c: StageColor) => void; onSave: () => void; onCancel: () => void; pending: boolean;
}) {
  return (
    <div className="absolute" style={style} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <span style={pinLook({ pin_color: color, from_client: false, resolved_at: null }).style}
        className={cn("flex size-6 -translate-x-1/2 -translate-y-1/2 animate-pulse items-center justify-center rounded-full border-2 text-[11px] font-bold",
          pinLook({ pin_color: color, from_client: false, resolved_at: null }).className)}>
        {n}
      </span>
      <form className={cn("absolute z-30 w-64 space-y-2 rounded-lg border bg-popover p-2.5 shadow-xl", pinSide(x, y))}
        onSubmit={(e) => { e.preventDefault(); onSave(); }}>
        <Textarea autoFocus rows={3} value={body} maxLength={2000} placeholder="What should change here?" aria-label="Note for this spot"
          onChange={(e) => onBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(); }
          }} />
        <PinColorDots value={color} onChange={(c) => { onColor(c); rememberPinColor(c); }} disabled={pending} />
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
          <Button type="submit" size="sm" disabled={pending || !body.trim()}>{pending ? <Loader2 className="animate-spin" /> : null}Pin note</Button>
        </div>
      </form>
    </div>
  );
}
