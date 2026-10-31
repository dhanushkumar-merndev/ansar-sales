"use client";

import { useSyncExternalStore } from "react";

// The lead page's "← Leads" goes back to the list the lead was opened from (tab, filters, page, page size),
// not always to /leads. The list remembers its address for the browser tab's session.
//
// Next keeps visited pages alive in the background, so a lead page opened earlier would otherwise keep the
// address from that earlier visit: writers notify readers, and the link reads it again when clicked.
const KEY = "leads:return";
const listeners = new Set<() => void>();

export function rememberLeadsList(url: string) {
  try {
    sessionStorage.setItem(KEY, url);
  } catch {
    // Storage off (private mode): Back falls back to /leads.
  }
  listeners.forEach((l) => l());
}

/** The remembered list address, read now. */
export function leadsReturnHref() {
  try {
    const saved = sessionStorage.getItem(KEY);
    return saved?.startsWith("/leads") ? saved : "/leads";
  } catch {
    return "/leads";
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The remembered list address; "/leads" on the server render, so hydration matches. */
export function useLeadsReturnHref() {
  return useSyncExternalStore(subscribe, leadsReturnHref, () => "/leads");
}
