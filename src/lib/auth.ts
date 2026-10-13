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
  /** Set when the current company is an ads client's CRM. */
  workspace: Workspace | null;
};

/** An ads client's CRM: a company of its own under the agency that runs the client's ads. */
export type Workspace = {
  parentId: string;
  parentName: string;
  adsClientId: string | null;
  /** False for the agency's staff, who switch in and act as Admin; true for the client's own staff. */
  member: boolean;
};

type Context = {
  company_id: string;
  workspace: { parent_id: string; parent_name: string; member: boolean; ads_client_id: string | null } | null;
};

/** Current user's authoritative profile (read through RLS on every request; never cached across requests). */
export const getCurrentProfile = cache(async (): Promise<CurrentProfile | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const uid = data?.claims?.sub;
  if (!uid) return null;
  const [{ data: profile }, { data: companies }, { data: context }] = await Promise.all([
    supabase.from("profiles").select("id, username, display_name, role, extra_roles, is_active").eq("id", uid).maybeSingle(),
    // RLS: the user's own company; every company for the super admin; the assigned ones for an ads
    // manager; plus the client CRMs the agency's staff may enter.
    supabase.from("companies").select("id, name, brand_highlight, logo_path, features, parent_company_id").is("archived_at", null).order("created_at").order("id"),
    // Where the database says this user is working now (private.current_company_id()).
    supabase.rpc("my_context"),
  ]);
  if (!profile) return null;
  const ctx = context as Context | null;
  const isSuperAdmin = profile.role === "super_admin";
  const switches = isSuperAdmin || profile.role === "ads_manager";
  const rows = companies ?? [];
  const currentRow = rows.find((c) => c.id === ctx?.company_id);
  const current = currentRow ? toCompanyBrand(currentRow) : undefined;
  const workspace: Workspace | null = ctx?.workspace
    ? { parentId: ctx.workspace.parent_id, parentName: ctx.workspace.parent_name, adsClientId: ctx.workspace.ads_client_id, member: ctx.workspace.member }
    : null;
  const main: AppRole = profile.role === "super_admin" ? "admin" : profile.role;
  // The agency's staff act as Admin inside a client CRM (private.my_roles()).
  const roles: AppRole[] = workspace && !workspace.member ? ["admin"] : [main, ...(profile.extra_roles as AppRole[]).filter((r) => r !== main)];
  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    role: roles.includes("admin") ? "admin" : roles.includes("sales") ? "sales" : roles[0],
    roles,
    // Users of an archived company (or a super admin with no company yet) cannot work.
    is_active: profile.is_active && Boolean(current),
    isSuperAdmin,
    company: current ?? { id: "", name: "", brandHighlight: null, logoUrl: null },
    // Client CRMs are opened from the client's page, not from the switcher.
    companies: switches ? rows.filter((c) => !c.parent_company_id).map(toCompanyBrand) : [],
    features: (currentRow?.features ?? []) as CompanyFeature[],
    workspace,
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
