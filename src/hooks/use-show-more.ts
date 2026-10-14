"use client";

import { useState } from "react";

/** Rows drawn at first in a long dropdown; scrolling near the end draws this many more. */
export const SHOW_MORE_STEP = 20;

/**
 * Draws a long, already-loaded list a page at a time: the first 20, then 20 more each time the
 * scroll box nears its end. Starts again at 20 whenever `resetKey` changes (e.g. the search text).
 */
export function useShowMore(total: number, resetKey: string, step = SHOW_MORE_STEP) {
  const [state, setState] = useState({ key: resetKey, count: step });
  const count = state.key === resetKey ? state.count : step;
  const onScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (count < total && el.scrollTop + el.clientHeight >= el.scrollHeight - 48) setState({ key: resetKey, count: count + step });
  };
  return { count, more: Math.max(0, total - count), onScroll };
}

/** The first `count` rows across groups shown one after another (e.g. "Our company", then "Clients"). */
export function sliceGroups<T>(groups: T[][], count: number): T[][] {
  let left = count;
  return groups.map((g) => {
    const shown = g.slice(0, Math.max(0, left));
    left -= shown.length;
    return shown;
  });
}
