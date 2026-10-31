"use client";

import { useSyncExternalStore } from "react";

// The lead page's "← Leads" goes back to the list the lead was opened from (tab, filters, page),
// not always to /leads. The list remembers its address for the browser tab's session.
const KEY = "leads:return";

export function rememberLeadsList(url: string) {
  try {
    sessionStorage.setItem(KEY, url);
  } catch {
    // Storage off (private mode): Back falls back to /leads.
  }
}

function read() {
  try {
    const saved = sessionStorage.getItem(KEY);
    return saved?.startsWith("/leads") ? saved : "/leads";
  } catch {
    return "/leads";
  }
}

const noSubscribe = () => () => undefined;

/** The remembered list address; "/leads" on the server render, so hydration matches. */
export function useLeadsReturnHref() {
  return useSyncExternalStore(noSubscribe, read, () => "/leads");
}
