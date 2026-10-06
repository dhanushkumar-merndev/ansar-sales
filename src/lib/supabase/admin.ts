import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { publicEnv, serverEnv } from "@/lib/env";

/**
 * Privileged client (bypasses RLS). Use ONLY for: Auth admin operations after an
 * active-Admin check, the verified Telegram webhook, the shared niche cache, and
 * signing a short-lived URL for a file the share token was already validated for,
 * and looking up the lead owner's Telegram chat when a customer opens a share link.
 */
export function createAdminClient() {
  return createClient<Database>(publicEnv.supabaseUrl, serverEnv("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
