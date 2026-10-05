import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import type { NicheOption } from "@/lib/types";

export const NICHES_TAG = "niches";

/**
 * Shared, non-sensitive default niche options (active niches, first 100 by name).
 * Callers MUST authorize the user as a lead user (admin/sales) before calling.
 * The same list is valid for every authorized user, so the cache key needs no user scope.
 * Invalidated with updateTag(NICHES_TAG) after niche mutations; browsers also refetch on Realtime events.
 */
export async function getCachedNicheOptions(): Promise<NicheOption[]> {
  "use cache";
  cacheTag(NICHES_TAG);
  cacheLife("hours");
  const { data, error } = await createAdminClient()
    .from("niches")
    .select("id, name")
    .is("archived_at", null)
    .order("normalized_name")
    .order("id")
    .limit(100);
  if (error) throw new Error("Failed to load niches");
  return data;
}
