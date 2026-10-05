import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { AppRole } from "@/lib/constants";
import { createClient } from "@/lib/supabase/server";

export type CurrentProfile = { id: string; username: string; display_name: string; role: AppRole; is_active: boolean };

/** Current user's authoritative profile (read through RLS on every request; never cached across requests). */
export const getCurrentProfile = cache(async (): Promise<CurrentProfile | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const uid = data?.claims?.sub;
  if (!uid) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, username, display_name, role, is_active")
    .eq("id", uid)
    .maybeSingle();
  return profile;
});

/** For pages: redirects when signed out, deactivated, or lacking one of the roles. */
export async function requireProfile(roles?: AppRole[]) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!profile.is_active) redirect("/login?error=inactive");
  if (roles && !roles.includes(profile.role)) redirect("/dashboard");
  return profile;
}

export class AuthorizationError extends Error {}

/** For server actions: returns the user's RLS client after verifying an active profile with an allowed role. */
export async function authorizeAction(roles: AppRole[]) {
  const profile = await getCurrentProfile();
  if (!profile || !profile.is_active || !roles.includes(profile.role)) throw new AuthorizationError("forbidden");
  return { profile, supabase: await createClient() };
}
