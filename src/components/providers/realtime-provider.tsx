"use client";

import { Suspense, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useProfile } from "@/components/providers/profile-provider";
import { realtimeTablesFor } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/client";

type Listener = () => void;
type Status = "connecting" | "live" | "offline";

type RealtimeContextValue = {
  status: Status;
  /** Subscribe to change events for tables; also fired after a reconnect so views can catch up. */
  subscribe: (tables: string[], listener: Listener) => () => void;
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

/**
 * One authenticated Realtime channel per signed-in session. Supabase applies RLS
 * to each postgres_changes event, so users only receive rows they may read.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("connecting");
  const listeners = useRef(new Map<Listener, Set<string>>());

  const value = useMemo<RealtimeContextValue>(
    () => ({
      status,
      subscribe(tableNames, listener) {
        listeners.current.set(listener, new Set(tableNames));
        return () => {
          listeners.current.delete(listener);
        };
      },
    }),
    [status],
  );

  return (
    <RealtimeContext.Provider value={value}>
      <Suspense fallback={null}>
        <RealtimeChannelSubscription listeners={listeners} onStatus={setStatus} />
      </Suspense>
      {children}
    </RealtimeContext.Provider>
  );
}

function RealtimeChannelSubscription({
  listeners,
  onStatus,
}: {
  listeners: React.RefObject<Map<Listener, Set<string>>>;
  onStatus: (status: Status) => void;
}) {
  const profile = useProfile();
  const userId = profile.id;
  const tablesKey = realtimeTablesFor(profile.role).join(",");

  useEffect(() => {
    const supabase = createClient();
    const tableList = tablesKey ? tablesKey.split(",") : [];
    if (tableList.length === 0) {
      onStatus("live");
      return;
    }
    let wasDisconnected = false;
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    const notify = (table: string | null) => {
      for (const [listener, subscribed] of listeners.current) {
        if (table === null || subscribed.has(table)) listener();
      }
    };

    (async () => {
      // Make sure Realtime uses the user's JWT so RLS is evaluated for this user.
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session) await supabase.realtime.setAuth(data.session.access_token);
      channel = supabase.channel(`crm:${userId}`);
      for (const table of tableList) {
        channel.on("postgres_changes", { event: "*", schema: "public", table }, () => notify(table));
      }
      channel.subscribe((state) => {
        if (state === "SUBSCRIBED") {
          onStatus("live");
          if (wasDisconnected) notify(null); // refetch anything missed while offline
          wasDisconnected = false;
        } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
          wasDisconnected = true;
          onStatus("offline");
        }
      });
    })();

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "TOKEN_REFRESHED" && session) void supabase.realtime.setAuth(session.access_token);
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId, tablesKey, listeners, onStatus]);

  return null;
}

export function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error("useRealtime must be used inside RealtimeProvider");
  return ctx;
}
