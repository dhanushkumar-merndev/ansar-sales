// The lead page's three reads, shared by the browser (queries.ts) and the server's first read
// (server/initial-data.ts), so both ask the database the same thing under the same query keys.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadOutcome, LeadTemperature, ReminderState } from "@/lib/constants";
import type { Database } from "@/lib/database.types";
import type { NicheOption } from "@/lib/types";

type Client = SupabaseClient<Database>;

/** Timeline rows shown first (and read by the server); "Show more" asks for more. */
export const TIMELINE_PAGE = 20;

export const leadKey = (userId: string, leadId: string) => `lead:${userId}:${leadId}`;
export const leadFollowUpsKey = (userId: string, leadId: string) => `lead-fu:${userId}:${leadId}`;
export const timelineKey = (userId: string, leadId: string, limit: number) => `timeline:${userId}:${leadId}:${limit}`;

export type LeadDetail = {
  id: string; name: string; company_name: string | null; phone: string; phone_normalized: string; email: string | null; status: LeadOutcome; stage_id: string;
  temperature: LeadTemperature | null;
  source: "manual" | "facebook"; source_meta: { form_name?: string; ad_name?: string; campaign_name?: string };
  version: number; created_at: string; updated_at: string; archived_at: string | null; owner_id: string;
  niche: NicheOption; owner: { id: string; display_name: string }; creator: { display_name: string } | null;
  stars: { pinned_at: string | null }[];
  /** Projects module: handed to admins, and the project made from it (when visible to this user). */
  handoff_at: string | null; handoff_note: string | null;
  projects: { id: string; code: string }[] | { id: string; code: string } | null;
};

export async function readLead(client: Client, id: string, signal?: AbortSignal) {
  let q = client
    .from("leads")
    .select(
      "id, name, company_name, phone, phone_normalized, email, status, stage_id, temperature, source, source_meta, version, created_at, updated_at, archived_at, owner_id, " +
        "niche:niches!leads_niche_id_fkey(id, name), owner:profiles!leads_owner_id_fkey(id, display_name), creator:profiles!leads_created_by_fkey(display_name), " +
        "stars:lead_stars(pinned_at), handoff_at, handoff_note, projects(id, code)", // RLS: only the user's own star; projects they may see
    )
    .eq("id", id);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data as unknown as LeadDetail | null;
}

export type LeadFollowUp = {
  id: string; task: string; due_at: string; state: "pending" | "completed" | "cancelled"; revision: number;
  assignee: { display_name: string } | null;
  reminder_deliveries: { revision: number; state: ReminderState; attempts: number; last_error: string | null; sent_at: string | null }[];
};

/** Pending follow-ups for one lead (bounded). */
export async function readLeadFollowUps(client: Client, leadId: string, signal?: AbortSignal) {
  let q = client
    .from("follow_ups")
    .select("id, task, due_at, state, revision, assignee:profiles!follow_ups_assignee_id_fkey(display_name), reminder_deliveries(revision, state, attempts, last_error, sent_at)")
    .eq("lead_id", leadId)
    .eq("state", "pending")
    .order("due_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(20);
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q;
  if (error) throw error;
  return data as unknown as LeadFollowUp[];
}

export type Activity = {
  id: string; type: string; body: string | null; meta: Record<string, unknown>; created_at: string; edited_at: string | null;
  follow_up_id: string | null; actor_id: string | null; actor: { display_name: string } | null;
};

export type TimelinePage = { items: Activity[]; hasMore: boolean };

/** Newest-first timeline; fetches one extra row to know whether more exist (no count needed). */
export async function readTimeline(client: Client, leadId: string, limit: number, signal?: AbortSignal): Promise<TimelinePage> {
  let q = client
    .from("lead_activities")
    .select("id, type, body, meta, created_at, edited_at, follow_up_id, actor_id, actor:profiles!lead_activities_actor_id_fkey(display_name)")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(0, limit); // inclusive: limit + 1 rows
  if (signal) q = q.abortSignal(signal);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data as unknown as Activity[];
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}
