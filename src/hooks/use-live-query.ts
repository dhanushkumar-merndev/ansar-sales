"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime } from "@/components/providers/realtime-provider";
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
};

const RETRY_DELAYS = [400, 1500];

/**
 * Fresh authorized reads with: newest-response-wins, abort of obsolete reads,
 * bounded retries, debounced Realtime refetch, refetch on focus/reconnect and a
 * slow polling fallback. Previous data stays visible while the next result loads.
 */
export function useLiveQuery<T>({ queryKey, fetcher, tables = [], enabled = true, pollMs = 60_000 }: Options<T>) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [dataKey, setDataKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const gate = useRef(createRequestGate());
  const fetcherRef = useRef(fetcher);
  const keyRef = useRef(queryKey);
  const inFlight = useRef(false);
  const rerun = useRef(false);
  const lastRun = useRef(0);
  const { subscribe } = useRealtime();

  useEffect(() => {
    fetcherRef.current = fetcher;
    keyRef.current = queryKey;
  });

  const run = useCallback(async (reason: "key" | "event") => {
    if (reason === "event" && inFlight.current) {
      rerun.current = true; // coalesce bursts into one follow-up read
      return;
    }
    const req = gate.current.begin();
    const key = keyRef.current;
    inFlight.current = true;
    lastRun.current = Date.now();
    setIsFetching(true);
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await fetcherRef.current(req.signal);
        if (!req.isLatest()) return;
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
        void run("event");
      }
    }
  }, []);

  // Query identity changed → fetch now (older in-flight read is aborted).
  useEffect(() => {
    if (!enabled) return;
    inFlight.current = false;
    rerun.current = false;
    void run("key");
  }, [queryKey, enabled, run]);

  // Realtime: debounce bursts; refetch the current server page (filters/page preserved).
  const tablesKey = tables.join(",");
  useEffect(() => {
    if (!enabled || !tablesKey) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(tablesKey.split(","), () => {
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

  return {
    data,
    error,
    isFetching,
    /** True until the first result for the current query identity has arrived. */
    isStale: dataKey !== queryKey,
    isInitialLoading: data === undefined && !error,
    refetch: () => run("event"),
  };
}
