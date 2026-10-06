import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { type CompanyBrand, toCompanyBrand } from "@/lib/companies";
import { type AppRole, homePathFor } from "@/lib/constants";
import { createClient } from "@/lib/supabase/server";

export type CurrentProfile = {
  id: string;
  username: string;
  display_name: string;
  /** Effective role in the current company: a super admin is "admin" there. */
  role: AppRole;
  is_active: boolean;
  isSuperAdmin: boolean;
  /** The company this user works in now (the super admin's active company). */
  company: CompanyBrand;
  /** Companies this user can switch between (super admin: all; ads manager: assigned); empty otherwise. */
  companies: CompanyBrand[];
};

/** Current user's authoritative profile (read through RLS on every request; never cached across requests). */
export const getCurrentProfile = cache(async (): Promise<CurrentProfile | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const uid = data?.claims?.sub;
  if (!uid) return null;
  const [{ data: profile }, { data: companies }] = await Promise.all([
    supabase.from("profiles").select("id, username, display_name, role, is_active, company_id, active_company_id").eq("id", uid).maybeSingle(),
    // RLS: the user's own company; every company for the super admin; the assigned ones for an ads manager.
    supabase.from("companies").select("id, name, brand_highlight, logo_path").is("archived_at", null).order("created_at").order("id"),
  ]);
  if (!profile) return null;
  const isSuperAdmin = profile.role === "super_admin";
  const switches = isSuperAdmin || profile.role === "ads_manager";
  const list = (companies ?? []).map(toCompanyBrand);
  // Same fallback as private.current_company_id(): the chosen company, else the oldest available.
  const current = switches
    ? (list.find((c) => c.id === profile.active_company_id) ?? list[0])
    : list.find((c) => c.id === profile.company_id);
  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    role: profile.role === "super_admin" ? "admin" : profile.role,
    // Users of an archived company (or a super admin with no company yet) cannot work.
    is_active: profile.is_active && Boolean(current),
    isSuperAdmin,
    company: current ?? { id: "", name: "", brandHighlight: null, logoUrl: null },
    companies: switches ? list : [],
  };
});

/**
 * For pages: redirects when signed out, deactivated, or lacking one of the roles.
 * Client logins only ever reach pages that name "client" (their portal).
 */
export async function requireProfile(roles?: AppRole[]) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!profile.is_active) redirect("/login?error=inactive");
  if (profile.role === "client" && !roles?.includes("client")) redirect("/portal");
  if (roles && !roles.includes(profile.role)) redirect(homePathFor(profile.role));
  return profile;
}

/** For pages only the super admin may open. */
export async function requireSuperAdmin() {
  const profile = await requireProfile();
  if (!profile.isSuperAdmin) redirect("/dashboard");
  return profile;
}

export class AuthorizationError extends Error {}

/** For server actions: returns the user's RLS client after verifying an active profile with an allowed role. */
export async function authorizeAction(roles: AppRole[] | "super_admin") {
  const profile = await getCurrentProfile();
  if (!profile || !profile.is_active) throw new AuthorizationError("forbidden");
  if (roles === "super_admin" ? !profile.isSuperAdmin : !roles.includes(profile.role)) throw new AuthorizationError("forbidden");
  return { profile, supabase: await createClient() };
}
