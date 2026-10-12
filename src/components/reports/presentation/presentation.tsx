"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Maximize, Minimize, X } from "lucide-react";
import { BrandMark } from "@/components/app/brand";
import { ErrorState } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { STAGE_H, STAGE_W, useReducedMotion } from "@/components/reports/presentation/deck-ui";
import { buildSlides, rangeText } from "@/components/reports/presentation/slides";
import { useDeckData } from "@/components/reports/presentation/use-deck-data";
import type { ReportRange } from "@/components/reports/report-range-picker";
import { Button } from "@/components/ui/button";
import { formatCalendarDate, istToday } from "@/lib/time";
import { cn } from "@/lib/utils";

const IDLE_MS = 2500;
const SWIPE_PX = 50;

/** Scale that fits the fixed-size stage inside the element. */
function useFitScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(el.clientWidth / STAGE_W, el.clientHeight / STAGE_H)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, scale] as const;
}

/**
 * Full-screen, animated slideshow of the business for the selected range ("Reports → Present").
 * Built from the same authorized report RPCs as the Reports page, and live like them.
 */
export function Presentation({ range, onClose }: { range: ReportRange; onClose: () => void }) {
  const profile = useProfile();
  const deck = useDeckData(range);
  const reduced = useReducedMotion();
  const generatedOn = formatCalendarDate(istToday());
  const slides = useMemo(
    () => (deck.loading ? [] : buildSlides({ data: deck.data, profile, range, generatedOn })),
    // deck.data is rebuilt each render; its parts are the stable query results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deck.loading, deck.data.leads, deck.data.finance, deck.data.ads, deck.data.clients, profile, range, generatedOn],
  );
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  // The slide animating out while the next one animates in.
  const [leaving, setLeaving] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [stageRef, scale] = useFitScale();
  const touchX = useRef<number | null>(null);
  const current = Math.min(index, Math.max(0, slides.length - 1));
  const slide = slides[current];

  const go = useCallback((to: number) => {
    const next = Math.max(0, Math.min(slides.length - 1, to));
    if (next === current) return;
    setDir(next > current ? 1 : -1);
    setLeaving(reduced ? null : slides[current]?.id ?? null);
    setIndex(next);
  }, [slides, current, reduced]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void rootRef.current?.requestFullscreen?.().catch(() => {});
  }, []);

  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    onClose();
  }, [onClose]);

  // Open in full screen (the browser may refuse without a recent click; the overlay still covers the page).
  useEffect(() => {
    rootRef.current?.focus();
    void rootRef.current?.requestFullscreen?.().catch(() => {});
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.body.style.overflow = overflow;
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) go(current + 1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) go(current - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(slides.length - 1);
      else if (e.key === "f" || e.key === "F") toggleFullscreen();
      else if (e.key === "Escape") close();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, current, slides.length, toggleFullscreen, close]);

  // Controls hide after a moment without the mouse moving.
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
  }, []);
  useEffect(() => {
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
    return () => window.clearTimeout(idleTimer.current);
  }, []);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Report presentation"
      className={cn("fixed inset-0 z-50 flex flex-col bg-[#0e0e0e] text-foreground outline-none", idle && "cursor-none")}
      onMouseMove={wake}
      onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; wake(); }}
      onTouchEnd={(e) => {
        const start = touchX.current;
        const end = e.changedTouches[0]?.clientX;
        touchX.current = null;
        if (start === null || end === undefined || Math.abs(end - start) < SWIPE_PX) return;
        go(current + (end < start ? 1 : -1));
      }}
    >
      <div ref={stageRef} className="relative min-h-0 flex-1">
        {scale > 0 ? (
          <div
            className="absolute top-1/2 left-1/2 overflow-hidden bg-background"
            style={{ width: STAGE_W, height: STAGE_H, transform: `translate(-50%, -50%) scale(${scale})` }}
          >
            {/* Progress */}
            <div className="absolute inset-x-0 top-0 z-10 h-0.5">
              <div className="h-full bg-red-500 transition-[width] duration-500 ease-out" style={{ width: slides.length ? `${((current + 1) / slides.length) * 100}%` : "0%" }} />
            </div>

            {deck.error ? (
              <div className="flex h-full items-center justify-center p-16"><div className="w-full max-w-lg"><ErrorState message={deck.error} onRetry={deck.retry} /></div></div>
            ) : !slide ? (
              <div className="flex h-full flex-col items-center justify-center gap-5">
                <BrandMark size={64} logoUrl={profile.company.logoUrl} />
                <p className="flex items-center gap-2 text-[17px] text-muted-foreground"><Loader2 className="size-5 animate-spin" /> Preparing {profile.company.name}&apos;s presentation…</p>
              </div>
            ) : (
              [...slides.filter((x) => x.id === leaving && x.id !== slide.id), slide].map((x) => {
                const out = x.id !== slide.id;
                return (
                  <div
                    key={x.id}
                    aria-hidden={out || undefined}
                    className={cn("absolute inset-0", !reduced && (out ? "deck-exit" : "deck-enter"))}
                    style={{ "--deck-dir": dir } as React.CSSProperties}
                    onAnimationEnd={(e) => { if (out && e.target === e.currentTarget) setLeaving(null); }}
                  >
                    {x.render()}
                  </div>
                );
              })
            )}

            {/* Footer */}
            {slide && slide.id !== "cover" && slide.id !== "closing" ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-14 items-center justify-between gap-6 px-16 text-[13px] text-muted-foreground">
                <span className="truncate">{profile.company.name} · {rangeText(range)}</span>
                <span className="tabular-nums">{current + 1}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Edge click zones */}
        {slides.length > 1 ? (
          <>
            <button type="button" aria-label="Previous slide" disabled={current === 0} onClick={() => go(current - 1)}
              className={cn("group absolute inset-y-0 left-0 hidden w-16 items-center justify-center transition-opacity sm:flex disabled:pointer-events-none disabled:opacity-0", idle && "opacity-0")}>
              <ChevronLeft className="size-8 text-white/30 transition-colors group-hover:text-white/80" />
            </button>
            <button type="button" aria-label="Next slide" disabled={current === slides.length - 1} onClick={() => go(current + 1)}
              className={cn("group absolute inset-y-0 right-0 hidden w-16 items-center justify-center transition-opacity sm:flex disabled:pointer-events-none disabled:opacity-0", idle && "opacity-0")}>
              <ChevronRight className="size-8 text-white/30 transition-colors group-hover:text-white/80" />
            </button>
          </>
        ) : null}
      </div>

      {/* Controls */}
      <div className={cn("flex h-14 shrink-0 items-center justify-between gap-3 px-4 transition-opacity duration-300", idle && "pointer-events-none opacity-0")}>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Previous slide" disabled={current === 0} onClick={() => go(current - 1)}><ChevronLeft /></Button>
          <span className="min-w-14 text-center text-sm text-muted-foreground tabular-nums">{slides.length ? `${current + 1} / ${slides.length}` : "…"}</span>
          <Button variant="ghost" size="icon-sm" aria-label="Next slide" disabled={current >= slides.length - 1} onClick={() => go(current + 1)}><ChevronRight /></Button>
        </div>
        <div className="hidden min-w-0 items-center gap-1.5 overflow-x-auto px-2 md:flex" role="tablist" aria-label="Slides">
          {slides.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={i === current}
              aria-label={`${i + 1}. ${s.title}`}
              title={`${i + 1}. ${s.title}`}
              onClick={() => go(i)}
              className={cn("h-1.5 rounded-full transition-all duration-300", i === current ? "w-6 bg-red-500" : "w-1.5 bg-white/25 hover:bg-white/50")}
            />
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-2 hidden text-xs text-muted-foreground lg:inline">← → to move · F full screen · Esc to close</span>
          {deck.isFetching && slide ? <Loader2 className="mr-1 size-4 animate-spin text-muted-foreground" aria-label="Refreshing" /> : null}
          <Button variant="ghost" size="icon-sm" aria-label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize /> : <Maximize />}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close presentation" onClick={close}><X /></Button>
        </div>
      </div>
    </div>
  );
}
