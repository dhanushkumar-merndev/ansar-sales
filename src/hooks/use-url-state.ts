"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * URL search params as list state (shareable, Back/Forward friendly). Uses the
 * History API, which Next.js syncs with useSearchParams without a server render.
 * Any change other than `page` resets to page 1.
 */
export function useUrlState() {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const set = useCallback(
    (updates: Record<string, string | null | undefined>, opts: { replace?: boolean } = {}) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      if (!("page" in updates)) next.delete("page");
      const qs = next.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (opts.replace) window.history.replaceState(null, "", url);
      else window.history.pushState(null, "", url);
    },
    [searchParams, pathname],
  );

  return { params: searchParams, set };
}
