"use client";

import { Suspense, createContext, useContext, useEffect, useMemo, useState } from "react";
import { useProfile } from "@/components/providers/profile-provider";
import { useLiveQuery } from "@/hooks/use-live-query";
import { can } from "@/lib/permissions";
import type { PipelineStage } from "@/lib/stages";
import { createClient } from "@/lib/supabase/client";

type StagesValue = {
  /** Active stages in pipeline order. */
  stages: PipelineStage[];
  /** Any stage of the company by id, including archived ones. */
  byId: Map<string, PipelineStage>;
  loading: boolean;
};

const StagesContext = createContext<StagesValue>({ stages: [], byId: new Map(), loading: true });

async function fetchStages(signal: AbortSignal) {
  const { data, error } = await createClient()
    .from("pipeline_stages")
    .select("id, name, position, kind, color, archived_at")
    .order("position")
    .order("id")
    .limit(100)
    .abortSignal(signal);
  if (error) throw error;
  return data as PipelineStage[];
}

/**
 * The current company's pipeline stages, live (RLS returns only that company's stages).
 * Children render right away; the stages arrive once the profile has resolved.
 */
export function StagesProvider({ children }: { children: React.ReactNode }) {
  const [all, setAll] = useState<PipelineStage[] | null>(null);
  const value = useMemo<StagesValue>(() => ({
    stages: (all ?? []).filter((s) => !s.archived_at),
    byId: new Map((all ?? []).map((s) => [s.id, s])),
    loading: all === null,
  }), [all]);
  return (
    <StagesContext.Provider value={value}>
      <Suspense fallback={null}><StagesLoader onData={setAll} /></Suspense>
      {children}
    </StagesContext.Provider>
  );
}

function StagesLoader({ onData }: { onData: (stages: PipelineStage[]) => void }) {
  const profile = useProfile();
  const enabled = can.useLeads(profile.role);
  const { data } = useLiveQuery({ queryKey: `stages:${profile.company.id}`, fetcher: fetchStages, tables: ["pipeline_stages"], enabled, pollMs: 0 });
  useEffect(() => {
    if (!enabled) onData([]);
    else if (data) onData(data);
  }, [data, enabled, onData]);
  return null;
}

export function useStages() {
  return useContext(StagesContext);
}
