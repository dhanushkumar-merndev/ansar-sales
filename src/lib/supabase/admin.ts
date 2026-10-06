import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { publicEnv, serverEnv } from "@/lib/env";

/**
 * Privileged client (bypasses RLS). Use ONLY for: Auth admin operations after an
 * active-Admin check (including the cross-company username uniqueness check), the
 * verified Telegram webhook, the per-company niche cache (filtered by the caller's
 * verified company), signing a short-lived URL for a file the share token was already
 * validated for, looking up the lead owner's Telegram chat when a customer opens a share link, and
 * the Facebook Lead Ads webhook (signature-verified) and the admins' Meta connect/sync, which
 * read a company's Meta secrets from Vault and create its leads, the ad sync (the secret-checked
 * cron route, or after the database authorized the user for that ad account), and creating client
 * portal logins after ads_client_login_check.
 */
export function createAdminClient() {
  return createClient<Database>(publicEnv.supabaseUrl, serverEnv("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
