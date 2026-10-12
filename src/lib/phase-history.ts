import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { PhaseEvent } from "@/lib/projects";

type Item = { type: string; phase_id: string | null; meta: { from?: PhaseEvent["from"]; to?: PhaseEvent["to"] }; created_at: string; actor: { display_name: string } | null };

/**
 * Every status change of a project's phases, oldest first (who and when). Works with the browser or the
 * server client. Before migration 20261008001300 is applied, project_phase_history doesn't exist yet, so the
 * same history is read from the project's activity feed (the newest 500 entries).
 */
export async function readPhaseHistory(client: SupabaseClient<Database>, projectId: string, signal?: AbortSignal): Promise<PhaseEvent[]> {
  const q = client.rpc("project_phase_history", { p_project_id: projectId });
  const { data, error } = await (signal ? q.abortSignal(signal) : q);
  if (!error) return (data ?? []) as unknown as PhaseEvent[];
  if (error.code !== "PGRST202") throw error;
  const events: PhaseEvent[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const pq = client.rpc("list_project_activities", { p_project_id: projectId, p_limit: 100, p_offset: offset });
    const page = await (signal ? pq.abortSignal(signal) : pq);
    if (page.error) throw page.error;
    const { items, has_more } = page.data as unknown as { items: Item[]; has_more: boolean };
    for (const a of items) {
      if (a.type === "phase_status_changed" && a.phase_id && a.meta.to) {
        events.push({ phase_id: a.phase_id, at: a.created_at, from: a.meta.from ?? null, to: a.meta.to, by: a.actor?.display_name ?? null });
      }
    }
    if (!has_more) break;
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}
