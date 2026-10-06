import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import type { NicheOption } from "@/lib/types";

/** Cache tag for one company's niche list. */
export const nichesTag = (companyId: string) => `niches:${companyId}`;

/**
 * Shared, non-sensitive default niche options for one company (active niches, first 100 by name).
 * Callers MUST authorize the user as a lead user (admin/sales) and pass the company from their
 * own verified profile: the cache key is the company, and the query is filtered to it.
 * Invalidated with updateTag(nichesTag(companyId)) after niche mutations; browsers also refetch on Realtime events.
 */
export async function getCachedNicheOptions(companyId: string): Promise<NicheOption[]> {
  "use cache";
  cacheTag(nichesTag(companyId));
  cacheLife("hours");
  const { data, error } = await createAdminClient()
    .from("niches")
    .select("id, name")
    .eq("company_id", companyId)
    .is("archived_at", null)
    .order("normalized_name")
    .order("id")
    .limit(100);
  if (error) throw new Error("Failed to load niches");
  return data;
}
