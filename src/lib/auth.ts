import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { type CompanyBrand, toCompanyBrand } from "@/lib/companies";
import { type AppRole, type CompanyFeature, homePathFor } from "@/lib/constants";
import { hasAnyRole } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export type CurrentProfile = {
  id: string;
  username: string;
  display_name: string;
  /**
   * Main effective role in the current company, by precedence: admin (a super admin, or admin as an
   * extra role), then sales, then the profile's main role. Matches private.app_role().
   */
  role: AppRole;
  /** Every role this person has here (main role first). Permissions are the union of all of them. */
  roles: AppRole[];
  is_active: boolean;
  isSuperAdmin: boolean;
  /** The company this user works in now (the super admin's active company). */
  company: CompanyBrand;
  /** Companies this user can switch between (super admin: all; ads manager: assigned); empty otherwise. */
  companies: CompanyBrand[];
  /** Optional modules switched on for the current company (e.g. "projects"). */
  features: CompanyFeature[];
};

/** Current user's authoritative profile (read through RLS on every request; never cached across requests). */
export const getCurrentProfile = cache(async (): Promise<CurrentProfile | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const uid = data?.claims?.sub;
  if (!uid) return null;
  const [{ data: profile }, { data: companies }] = await Promise.all([
    supabase.from("profiles").select("id, username, display_name, role, extra_roles, is_active, company_id, active_company_id").eq("id", uid).maybeSingle(),
    // RLS: the user's own company; every company for the super admin; the assigned ones for an ads manager.
    supabase.from("companies").select("id, name, brand_highlight, logo_path, features").is("archived_at", null).order("created_at").order("id"),
  ]);
  if (!profile) return null;
  const isSuperAdmin = profile.role === "super_admin";
  const switches = isSuperAdmin || profile.role === "ads_manager";
  const rows = companies ?? [];
  // Same fallback as private.current_company_id(): the chosen company, else the oldest available.
  const currentRow = switches
    ? (rows.find((c) => c.id === profile.active_company_id) ?? rows[0])
    : rows.find((c) => c.id === profile.company_id);
  const current = currentRow ? toCompanyBrand(currentRow) : undefined;
  const main: AppRole = profile.role === "super_admin" ? "admin" : profile.role;
  const roles: AppRole[] = [main, ...(profile.extra_roles as AppRole[]).filter((r) => r !== main)];
  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    role: roles.includes("admin") ? "admin" : roles.includes("sales") ? "sales" : main,
    roles,
    // Users of an archived company (or a super admin with no company yet) cannot work.
    is_active: profile.is_active && Boolean(current),
    isSuperAdmin,
    company: current ?? { id: "", name: "", brandHighlight: null, logoUrl: null },
    companies: switches ? rows.map(toCompanyBrand) : [],
    features: (currentRow?.features ?? []) as CompanyFeature[],
  };
});

/**
 * For pages: redirects when signed out, deactivated, or lacking every one of the roles.
 * Client logins only ever reach pages that name "client" (their portal).
 */
export async function requireProfile(roles?: AppRole[]) {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!profile.is_active) redirect("/login?error=inactive");
  if (profile.role === "client" && !roles?.includes("client")) redirect("/portal");
  if (roles && !hasAnyRole(profile.roles, roles)) redirect(homePathFor(profile.role));
  return profile;
}

/** For pages of an optional module: like requireProfile, and the company must have the module on. */
export async function requireFeature(feature: CompanyFeature, roles?: AppRole[]) {
  const profile = await requireProfile(roles);
  if (!profile.features.includes(feature)) {
    // A project-only person whose company lost the module lands on Settings instead of looping.
    const home = homePathFor(profile.role);
    redirect(home === "/projects" || home === "/my-work" ? "/settings" : home);
  }
  return profile;
}

/** For the Ads and Automation pages: off in companies whose ads Star Growth Hub runs ("no_ads"). */
export async function requireAds(roles: AppRole[]) {
  const profile = await requireProfile(roles);
  if (profile.features.includes("no_ads")) redirect(homePathFor(profile.role) === "/ads" ? "/settings" : homePathFor(profile.role));
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
  if (roles === "super_admin" ? !profile.isSuperAdmin : !hasAnyRole(profile.roles, roles)) throw new AuthorizationError("forbidden");
  return { profile, supabase: await createClient() };
}
