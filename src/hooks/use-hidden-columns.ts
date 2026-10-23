"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useProfile } from "@/components/providers/profile-provider";
import { useLiveQuery } from "@/hooks/use-live-query";
import { createClient } from "@/lib/supabase/client";
import type { ColumnTable } from "@/lib/table-columns";
import { setTableColumns } from "@/server/actions/preferences";

type Prefs = Partial<Record<ColumnTable, string[]>>;

async function fetchPrefs(signal: AbortSignal): Promise<Prefs> {
  const { data, error } = await createClient().from("user_table_prefs").select("columns").abortSignal(signal).maybeSingle();
  // Before the database update the table is missing: nothing is hidden.
  if (error?.code === "42P01" || error?.code === "PGRST205") return {};
  if (error) throw error;
  return (data?.columns ?? {}) as Prefs;
}

/**
 * The columns the signed-in person hid on a list (saved to their account, so it follows them),
 * and a setter that shows the change at once and rolls back if saving fails.
 */
export function useHiddenColumns(table: ColumnTable) {
  const profile = useProfile();
  const prefs = useLiveQuery({ queryKey: `table-prefs:${profile.id}`, fetcher: fetchPrefs, keep: true, pollMs: 5 * 60_000 });
  const [pending, setPending] = useState<string[] | null>(null);
  const [seen, setSeen] = useState(prefs.data);
  if (seen !== prefs.data) {
    setSeen(prefs.data);
    setPending(null);
  }
  const hiddenList = pending ?? prefs.data?.[table] ?? [];

  const setHidden = async (next: string[]) => {
    setPending(next);
    const r = await setTableColumns({ table, hidden: next });
    if (!r.ok) {
      setPending(null);
      toast.error(r.error);
      return false;
    }
    prefs.refetch();
    return true;
  };

  return { hidden: new Set(hiddenList), hiddenList, setHidden, loading: prefs.isInitialLoading };
}
