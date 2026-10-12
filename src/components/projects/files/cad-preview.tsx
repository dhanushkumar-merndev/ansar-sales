"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, Maximize, MessageSquarePlus, Moon, Sun } from "lucide-react";
import { toast } from "sonner";
import type { CadView } from "@/components/projects/files/cad-engine";
import { NotePin, PinDraft, isPinned, lastPinColor } from "@/components/projects/files/note-pin";
import { Button } from "@/components/ui/button";
import { formatBytes, type FileComment } from "@/lib/projects";
import type { StageColor } from "@/lib/stages";
import { cn } from "@/lib/utils";
import { addFileComment, signProjectFileUrl } from "@/server/actions/project-files";

// Drawings up to this size open by themselves; bigger ones wait for "Open drawing" (they take a while).
const AUTO_OPEN_BYTES = 40 * 1024 * 1024;

// Canvas colours: soft paper like a printed plot (the default; the clearest — not stark white), or the
// panel's charcoal. Kept per browser.
const BACKGROUNDS = { dark: { hex: 0x262626, css: "bg-[#262626]" }, paper: { hex: 0xe9e7e2, css: "bg-[#e9e7e2]" } } as const;
type Background = keyof typeof BACKGROUNDS;
const BG_KEY = "cad-background";
const savedBackground = (): Background => {
  try { return window.localStorage.getItem(BG_KEY) === "dark" ? "dark" : "paper"; } catch { return "paper"; }
};

// The last couple of drawings stay in memory, so closing and reopening the panel (or switching back to a
// version) doesn't download them again. Versions never change, so the bytes can't go stale.
const recent = new Map<string, ArrayBuffer>();
const remember = (id: string, data: ArrayBuffer) => {
  recent.delete(id);
  recent.set(id, data);
  while (recent.size > 2) recent.delete(recent.keys().next().value!);
};

type Phase = { at: "idle" } | { at: "loading"; got: number; total: number } | { at: "drawing" } | { at: "ready" } | { at: "error"; message: string };

/**
 * DWG / DXF in the file panel: scroll or pinch to zoom, drag to move, "Fit" to see it all. Notes pin to a
 * point of the drawing (its own coordinates), so they stay on that spot at any zoom.
 */
export function CadPreview({ versionId, fileName, size, comments, wide, active, onActive, onPinned }: {
  versionId: string; fileName: string; size: number; comments: FileComment[]; wide: boolean;
  active: string | null; onActive: (id: string | null) => void; onPinned: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [want, setWant] = useState(size <= AUTO_OPEN_BYTES);
  const [phase, setPhase] = useState<Phase>(want ? { at: "loading", got: 0, total: size } : { at: "idle" });
  const [view, setView] = useState<CadView | null>(null);
  // Re-render on every pan / zoom so the pins follow; also the frame's size for picking the card side.
  const [frame, setFrame] = useState({ w: 1, h: 1, n: 0 });
  const [pinning, setPinning] = useState(false);
  const [draft, setDraft] = useState<{ x: number; y: number; body: string; color: StageColor } | null>(null);
  const [pending, start] = useTransition();
  const press = useRef<{ x: number; y: number } | null>(null);
  const [bg, setBg] = useState<Background>(savedBackground);
  const bgRef = useRef(bg);
  const toggleBg = () => {
    const next: Background = bg === "dark" ? "paper" : "dark";
    setBg(next);
    bgRef.current = next;
    view?.setBackground(BACKGROUNDS[next].hex);
    try { window.localStorage.setItem(BG_KEY, next); } catch { /* private window: just not remembered */ }
  };

  useEffect(() => {
    const el = host.current;
    if (!want || !el) return;
    let cancelled = false;
    let opened: CadView | null = null;
    const abort = new AbortController();
    (async () => {
      const kept = recent.get(versionId);
      const bytes = kept ? new Uint8Array(kept) : await download();
      if (cancelled) return;
      if (!kept) remember(versionId, bytes.buffer as ArrayBuffer);
      setPhase({ at: "drawing" });
      const { openCad } = await import("@/components/projects/files/cad-engine");
      if (cancelled) return;
      opened = await openCad(el, fileName, bytes.slice().buffer, { background: BACKGROUNDS[bgRef.current].hex }); // a copy: the reader may take over its buffer
      if (cancelled) { void opened.destroy(); return; }
      setView(opened);
      setPhase({ at: "ready" });
    })().catch((e: unknown) => {
      if (cancelled) return;
      const message = e instanceof Error && e.message === "cad_open_failed"
        ? "This drawing couldn't be read here (very new or unusual DWG features)."
        : e instanceof Error && e.name !== "AbortError" && !/^(download_failed|cad_)/.test(e.message) ? e.message : "The drawing didn't load.";
      setPhase({ at: "error", message });
    });
    async function download() {
      const signed = await signProjectFileUrl({ versionId, download: false });
      if (!signed.ok) throw new Error(signed.error);
      const res = await fetch(signed.data.url, { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error("download_failed");
      const total = Number(res.headers.get("content-length")) || size;
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let got = 0, shown = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (got - shown > 512 * 1024) { shown = got; setPhase({ at: "loading", got, total }); }
      }
      const bytes = new Uint8Array(got);
      let at = 0;
      for (const p of parts) { bytes.set(p, at); at += p.length; }
      return bytes;
    }
    return () => { cancelled = true; abort.abort(); void opened?.destroy(); };
  }, [want, versionId, fileName, size]);

  useEffect(() => {
    if (!view) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = host.current;
        if (el) setFrame((f) => ({ w: el.clientWidth || 1, h: el.clientHeight || 1, n: f.n + 1 }));
      });
    };
    update();
    const off = view.onChange(update);
    return () => { off(); cancelAnimationFrame(raf); };
  }, [view]);

  const pins = comments.filter(isPinned);
  const save = () => draft && draft.body.trim() && start(async () => {
    const r = await addFileComment({ versionId, body: draft.body, cad: { x: draft.x, y: draft.y }, color: draft.color });
    if (!r.ok) return void toast.error(r.error);
    toast.success("Note pinned");
    setDraft(null);
    onPinned();
  });
  // Where a drawing point is in the frame right now (pixels and percent); null when off-screen.
  const place = (x: number, y: number) => {
    if (!view) return null;
    const s = view.toScreen({ x, y });
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || s.x < -12 || s.y < -12 || s.x > frame.w + 12 || s.y > frame.h + 12) return null;
    return { style: { left: s.x, top: s.y }, x: (s.x / frame.w) * 100, y: (s.y / frame.h) * 100 };
  };
  const draftAt = draft ? place(draft.x, draft.y) : null;
  const height = wide ? "h-[calc(100dvh-14rem)]" : "h-[65vh]";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={pinning ? "secondary" : "outline"} disabled={phase.at !== "ready"} onClick={() => { setPinning((p) => !p); setDraft(null); }}>
          <MessageSquarePlus /> {pinning ? "Click a spot on the drawing…" : "Pin a note"}
        </Button>
        {pinning ? <Button size="sm" variant="ghost" onClick={() => setPinning(false)}>Cancel</Button> : null}
        <Button size="sm" variant="ghost" disabled={!view} onClick={() => view?.fit()}><Maximize /> Fit</Button>
        <Button size="sm" variant="ghost" onClick={toggleBg} title={bg === "dark" ? "Show on white, like a print" : "Show on dark"}>
          {bg === "dark" ? <><Sun /> Paper</> : <><Moon /> Dark</>}
        </Button>
        <span className="text-xs text-muted-foreground">
          {phase.at === "ready" ? `Scroll or pinch to zoom · drag to move${pins.length ? ` · ${pins.length} pin${pins.length === 1 ? "" : "s"}` : ""}` : ""}
        </span>
      </div>
      <div className={cn("relative overflow-hidden rounded-lg border", BACKGROUNDS[bg].css, height)}>
        {/* The viewer's canvas goes in here; its own command bar and toolbars are hidden (globals.css, .cad-host). */}
        <div ref={host} className={cn("cad-host absolute inset-0", pinning && "cursor-crosshair [&_canvas]:cursor-crosshair")}
          onPointerDown={(e) => { press.current = { x: e.clientX, y: e.clientY }; }}
          onPointerUp={(e) => {
            // A click (not a drag to move the drawing) places the pin.
            const p = press.current;
            press.current = null;
            if (!pinning || !view || !p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;
            const r = e.currentTarget.getBoundingClientRect();
            const w = view.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
            setDraft({ x: w.x, y: w.y, body: "", color: lastPinColor() });
            setPinning(false);
          }} />
        {view ? (
          <div className="pointer-events-none absolute inset-0 [&>*]:pointer-events-auto">
            {pins.map((c, i) => {
              const at = c.cad_x != null && c.cad_y != null ? place(c.cad_x, c.cad_y) : null;
              return at ? <NotePin key={c.id} c={c} n={i + 1} active={active === c.id} onActive={onActive} style={at.style} x={at.x} y={at.y} /> : null;
            })}
            {draft && draftAt ? (
              <PinDraft n={pins.length + 1} style={draftAt.style} x={draftAt.x} y={draftAt.y} body={draft.body} pending={pending}
                onBody={(body) => setDraft({ ...draft, body })} color={draft.color} onColor={(color) => setDraft({ ...draft, color })}
                onSave={save} onCancel={() => setDraft(null)} />
            ) : null}
          </div>
        ) : null}
        {phase.at !== "ready" ? (
          <div className={cn("absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm", bg === "paper" ? "text-neutral-500" : "text-muted-foreground")}>
            {phase.at === "idle" ? (
              <>
                <span>This drawing is {formatBytes(size)}. Opening it here can take a little while.</span>
                <Button size="sm" onClick={() => { setWant(true); setPhase({ at: "loading", got: 0, total: size }); }}>Open drawing</Button>
              </>
            ) : phase.at === "error" ? (
              <>
                <span className="text-red-300">{phase.message}</span>
                <span>Download it to open in AutoCAD or a free DWG viewer.</span>
              </>
            ) : (
              <>
                <Loader2 className="size-6 animate-spin" />
                <span>{phase.at === "loading" ? `Loading the drawing… ${formatBytes(phase.got)} of ${formatBytes(phase.total)}` : "Drawing it…"}</span>
                {phase.at === "loading" ? (
                  <div className="h-1.5 w-56 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-sky-400" style={{ width: `${Math.min(100, (phase.got / Math.max(1, phase.total)) * 100)}%` }} />
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
