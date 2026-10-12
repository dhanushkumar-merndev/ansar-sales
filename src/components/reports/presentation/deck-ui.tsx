"use client";

import { Children, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChartMotion } from "@/components/charts/chart-motion";
import { cn } from "@/lib/utils";

/** Design size of every slide; the stage is scaled to fit the screen. */
export const STAGE_W = 1280;
export const STAGE_H = 720;

/** When content step `n` fades in, in ms after the slide appears (the title goes first). */
export const at = (step: number) => 220 + step * 70;

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

export function useReducedMotion() {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(REDUCE_QUERY);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(REDUCE_QUERY).matches,
    () => false,
  );
}

/** Fades its content up into place at content step `step` (or after `delay` ms). */
export function Reveal({ step = 0, delay, className, children }: {
  step?: number; delay?: number; className?: string; children: React.ReactNode;
}) {
  return <div className={cn("deck-reveal", className)} style={{ animationDelay: `${delay ?? at(step)}ms` }}>{children}</div>;
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** A number that counts up to `value` once, and glides to new values on live updates. */
export function CountUp({ value, format, delay = 250, duration = 900 }: {
  value: number; format: (n: number) => string; delay?: number; duration?: number;
}) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(0);
  const from = useRef(0);

  useEffect(() => {
    if (reduced) return;
    const start = from.current;
    let raf = 0;
    let t0: number | null = null;
    const timer = window.setTimeout(() => {
      const tick = (now: number) => {
        t0 ??= now;
        const p = Math.min(1, (now - t0) / duration);
        const v = start + (value - start) * easeOutCubic(p);
        from.current = v;
        setShown(v);
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [value, delay, duration, reduced]);

  // Whole-number targets never show fractions mid-count.
  const v = reduced ? value : Number.isInteger(value) ? Math.round(shown) : shown;
  return <span className="tabular-nums">{format(v)}</span>;
}

/** Section label, a headline that states the finding, an optional note, then the slide body. */
export function SlideFrame({ kicker, title, subtitle, children, className }: {
  kicker: string; title: string; subtitle?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className="flex h-full flex-col px-16 pt-14 pb-20">
      <Reveal delay={0}><p className="text-[14px] text-muted-foreground">{kicker}</p></Reveal>
      <Reveal delay={60}><h2 className="mt-2 truncate text-[36px] leading-tight font-semibold tracking-[-0.015em]">{title}</h2></Reveal>
      {subtitle ? <Reveal delay={120}><p className="mt-2 truncate text-[16px] text-muted-foreground">{subtitle}</p></Reveal> : null}
      <div className={cn("mt-8 min-h-0 flex-1", className)}>{children}</div>
    </div>
  );
}

/**
 * One figure: the number, its label and an optional note. No box: stats sit on the slide, divided
 * by thin rules. `value` null shows "—" (a ratio with a zero denominator). `alert` marks a figure
 * that needs attention (e.g. overdue follow-ups) in red.
 */
export function Stat({ label, value, format, hint, alert, step = 0, size = "lg" }: {
  label: string; value: number | null; format: (n: number) => string; hint?: string; alert?: boolean;
  step?: number; size?: "lg" | "md";
}) {
  return (
    <Reveal step={step} className="min-w-0">
      <div className="border-t border-white/10 pt-4">
        <div className={cn("truncate font-semibold tracking-[-0.02em]", size === "lg" ? "text-[44px] leading-none" : "text-[30px] leading-none", alert && "text-red-400")}>
          {value === null ? "—" : <CountUp value={value} format={format} delay={at(step) + 100} />}
        </div>
        <p className="mt-3 truncate text-[15px] text-foreground/80">{label}</p>
        {hint ? <p className="mt-1 truncate text-[13px] text-muted-foreground">{hint}</p> : null}
      </div>
    </Reveal>
  );
}

/** A row of stats in equal columns. */
export function StatRow({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-x-10" style={{ gridTemplateColumns: `repeat(${Children.count(children)}, minmax(0, 1fr))` }}>{children}</div>;
}

/** A titled area holding a chart or list. Charts inside build once the area has faded in. */
export function Panel({ title, note, children, className, step = 0 }: {
  title?: string; note?: string; children: React.ReactNode; className?: string; step?: number;
}) {
  const motion = useMemo(() => ({ delay: at(step) + 250 }), [step]);
  return (
    <Reveal step={step} className={cn("flex min-h-0 flex-col", className)}>
      {title ? (
        <div className="mb-4 flex items-baseline justify-between gap-3 border-b border-white/10 pb-2.5">
          <h3 className="text-[15px] font-medium text-foreground/90">{title}</h3>
          {note ? <span className="truncate text-[13px] text-muted-foreground">{note}</span> : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1"><ChartMotion value={motion}>{children}</ChartMotion></div>
    </Reveal>
  );
}

/** Ranked rows with a thin bar each; widths are relative to the largest value. */
export function BarList({ rows, step = 0 }: {
  rows: { key: string; label: string; sub?: string; value: number; display: string; extra?: string }[]; step?: number;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ol className="space-y-4">
      {rows.map((r, i) => (
        <li key={r.key}>
          <Reveal step={step + i + 1}>
            <div className="mb-1.5 flex items-baseline justify-between gap-4 text-[15px]">
              <span className="min-w-0 truncate">
                <span className="mr-2.5 text-muted-foreground tabular-nums">{i + 1}</span>
                {r.label}
                {r.sub ? <span className="ml-2 text-[13px] text-muted-foreground">{r.sub}</span> : null}
              </span>
              <span className="shrink-0 tabular-nums">
                <span className="font-medium">{r.display}</span>
                {r.extra ? <span className="ml-2 text-[13px] text-muted-foreground">{r.extra}</span> : null}
              </span>
            </div>
            <div className="h-1 bg-white/[0.07]">
              <div
                className={cn("deck-grow h-full", i === 0 ? "bg-foreground/85" : "bg-foreground/45")}
                style={{ width: `${max > 0 ? Math.max(1, (r.value / max) * 100) : 0}%`, animationDelay: `${at(step + i + 1) + 120}ms` }}
              />
            </div>
          </Reveal>
        </li>
      ))}
    </ol>
  );
}

export function SlideEmpty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center border border-dashed border-white/10 text-[16px] text-muted-foreground">{text}</div>;
}
