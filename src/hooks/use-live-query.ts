"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type RealtimeEvent, useOptionalRealtime } from "@/components/providers/realtime-provider";
import { REALTIME_DEBOUNCE_MS } from "@/lib/constants";
import { friendlyReadError } from "@/lib/errors";
import { createRequestGate, isAbortError } from "@/lib/request-gate";

type Options<T> = {
  /** Identity of the query: every filter, sort, page and page size. Changing it refetches. */
  queryKey: string;
  fetcher: (signal: AbortSignal) => Promise<T>;
  /** Tables whose Realtime events should refresh this view. */
  tables?: string[];
  enabled?: boolean;
  /** Freshness fallback while the tab is visible (covers events RLS hides, e.g. reassignment away). */
  pollMs?: number;
  /**
   * Keep the last result for this key in memory, so coming back to the page shows it at once while it
   * refreshes. Only for keys that include the user's id (sign-out clears it; a company switch reloads the app).
   */
  keep?: boolean;
  /**
   * The server's first read, streamed with the page: used on mount instead of a browser read when its key
   * matches (null or a different key falls back to fetching).
   */
  initial?: Promise<{ key: string; data: T; at: number } | null>;
  /** Realtime filter: return false for events that cannot affect this query (e.g. another lead's change). */
  match?: (event: RealtimeEvent) => boolean;
};

const RETRY_DELAYS = [400, 1500];
const KEEP_MAX_AGE_MS = 10 * 60_000;
const KEEP_MAX_ENTRIES = 40;
/** A server first read older than this (a page the browser kept, or preloaded on hover) is read again. */
const INITIAL_MAX_AGE_MS = 10_000;
const kept = new Map<string, { data: unknown; at: number }>();

function keptData<T>(key: string): T | undefined {
  const hit = kept.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > KEEP_MAX_AGE_MS) {
    kept.delete(key);
    return undefined;
  }
  return hit.data as T;
}

function keep(key: string, data: unknown) {
  kept.delete(key); // re-insert: the Map's order is least recently stored first
  kept.set(key, { data, at: Date.now() });
  if (kept.size > KEEP_MAX_ENTRIES) kept.delete(kept.keys().next().value!);
}

/**
 * Realtime filter for one lead's queries: only that lead's row and rows pointing at it (lead_id). Rows
 * without either column (other tables, or deletes that carry only the primary key) still match.
 */
export function forLead(leadId: string) {
  return ({ table, row }: RealtimeEvent) => {
    const id = table === "leads" ? row.id : row.lead_id;
    return id === undefined || id === leadId;
  };
}

/**
 * Fresh authorized reads with: newest-response-wins, abort of obsolete reads,
 * bounded retries, debounced Realtime refetch, refetch on focus/reconnect and a
 * slow polling fallback. Previous data stays visible while the next result loads.
 */
export function useLiveQuery<T>({ queryKey, fetcher, tables = [], enabled = true, pollMs = 60_000, keep: keepResult = false, initial, match }: Options<T>) {
  const [first] = useState(() => (keepResult ? keptData<T>(queryKey) : undefined));
  const [data, setData] = useState<T | undefined>(first);
  const [dataKey, setDataKey] = useState<string | null>(first === undefined ? null : queryKey);
  const [error, setError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const gate = useRef(createRequestGate());
  const fetcherRef = useRef(fetcher);
  const keyRef = useRef(queryKey);
  const keepRef = useRef(keepResult);
  const matchRef = useRef(match);
  // Only the first mount may use the server's read; afterwards the browser reads.
  const initialRef = useRef(initial);
  const runs = useRef(0);
  const inFlight = useRef(false);
  const rerun = useRef(false);
  const lastRun = useRef(0);
  const runRef = useRef<(reason: "key" | "event") => Promise<void>>(async () => {});
  // Pages outside the staff app (the client portal) have no provider: polling and focus refetch still apply.
  const subscribe = useOptionalRealtime()?.subscribe;

  useEffect(() => {
    fetcherRef.current = fetcher;
    keyRef.current = queryKey;
    keepRef.current = keepResult;
    matchRef.current = match;
  });

  const run = useCallback(async (reason: "key" | "event") => {
    if (reason === "event" && inFlight.current) {
      rerun.current = true; // coalesce bursts into one follow-up read
      return;
    }
    const req = gate.current.begin();
    runs.current++;
    const key = keyRef.current;
    inFlight.current = true;
    lastRun.current = Date.now();
    setIsFetching(true);
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await fetcherRef.current(req.signal);
        if (!req.isLatest()) return;
        if (keepRef.current) keep(key, result);
        setData(result);
        setDataKey(key);
        setError(null);
        break;
      } catch (e) {
        if (!req.isLatest() || isAbortError(e)) return;
        if (attempt < RETRY_DELAYS.length && !/forbidden|permission|invalid/i.test((e as Error)?.message ?? "")) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
          if (!req.isLatest()) return;
          continue;
        }
        setError(friendlyReadError(e));
        break;
      }
    }
    if (req.isLatest()) {
      inFlight.current = false;
      setIsFetching(false);
      if (rerun.current) {
        rerun.current = false;
        void runRef.current("event");
      }
    }
  }, []);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  // Query identity changed → fetch now (older in-flight read is aborted).
  useEffect(() => {
    if (!enabled) return;
    inFlight.current = false;
    rerun.current = false;
    // A kept result for the new key (e.g. back to page 1) shows at once; the read below refreshes it.
    const hit = keepRef.current ? keptData<T>(queryKey) : undefined;
    if (hit !== undefined) {
      setData(hit);
      setDataKey(queryKey);
    }
    const pending = initialRef.current;
    initialRef.current = undefined;
    if (pending && hit === undefined) {
      let cancelled = false;
      const runsBefore = runs.current;
      lastRun.current = Date.now();
      const fallback = () => {
        if (!cancelled && runs.current === runsBefore) void run("key");
      };
      pending.then((r) => {
        // Ignore it if the key changed or a newer read (e.g. after a Realtime event) already started.
        if (cancelled || runs.current !== runsBefore) return;
        if (!r || r.key !== keyRef.current) return fallback();
        if (keepRef.current) keep(r.key, r.data);
        setData(r.data);
        setDataKey(r.key);
        setError(null);
        lastRun.current = Date.now();
        // Shown at once; read again when the page was kept or preloaded a while ago (or the clocks disagree).
        if (Math.abs(Date.now() - r.at) > INITIAL_MAX_AGE_MS) void run("event");
      }, fallback);
      return () => {
        cancelled = true;
      };
    }
    void run("key");
  }, [queryKey, enabled, run]);

  // Realtime: debounce bursts; refetch the current server page (filters/page preserved).
  const tablesKey = tables.join(",");
  useEffect(() => {
    if (!enabled || !tablesKey || !subscribe) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(tablesKey.split(","), (event) => {
      if (event && matchRef.current && !matchRef.current(event)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void run("event"), REALTIME_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [tablesKey, enabled, subscribe, run]);

  // Focus / reconnect / polling fallback.
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRun.current > 2000) void run("event");
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = pollMs > 0 ? setInterval(refresh, pollMs) : undefined;
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(interval);
    };
  }, [enabled, pollMs, run]);

  useEffect(() => {
    const g = gate.current;
    return () => g.cancel();
  }, []);

  // Stable identity: views memoize on it (e.g. table columns), and a new function each render would remount their cells.
  const refetch = useCallback(() => run("event"), [run]);

  return {
    data,
    error,
    isFetching,
    /** True until the first result for the current query identity has arrived. */
    isStale: dataKey !== queryKey,
    isInitialLoading: data === undefined && !error,
    refetch,
  };
}
