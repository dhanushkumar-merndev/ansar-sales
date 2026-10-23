"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "next/navigation";

/** How long the mouse rests on a lead before its page is preloaded (passing over a list loads nothing). */
const DWELL_MS = 100;

type PrefetchOptions = Parameters<ReturnType<typeof useRouter>["prefetch"]>[1];
/** The whole page, its first reads included (PrefetchKind.FULL; the enum isn't exported publicly). */
const FULL = { kind: "full" } as unknown as PrefetchOptions;

/**
 * Props for a row or link that opens a lead: while the mouse rests on it (or a finger touches it), the
 * lead page is preloaded with its lead, follow-ups and timeline (kept by the browser for 60 s,
 * staleTimes.static), so the click shows it at once.
 */
export function useLeadPrefetch() {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useMemo(() => {
    const preload = (leadId: string) => router.prefetch(`/leads/${leadId}`, FULL);
    return (leadId: string) => ({
      onPointerEnter: (e: React.PointerEvent) => {
        if (e.pointerType !== "mouse") return;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => preload(leadId), DWELL_MS);
      },
      onPointerLeave: () => clearTimeout(timer.current),
      onTouchStart: () => preload(leadId),
    });
  }, [router]);
}
