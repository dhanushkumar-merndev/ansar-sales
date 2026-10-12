import type { AppRole } from "@/lib/constants";

/** One role or a person's full role list (permissions are the union of all their roles). */
export type Roles = AppRole | readonly AppRole[];

export function hasAnyRole(roles: Roles, wanted: readonly AppRole[]) {
  return (typeof roles === "string" ? [roles] : roles).some((r) => wanted.includes(r));
}

const any = (...wanted: AppRole[]) => (r: Roles) => hasAnyRole(r, wanted);

export const can = {
  manageUsers: any("admin"),
  viewAllLeads: any("admin"),
  useLeads: any("admin", "sales"),
  assignLeads: any("admin"),
  archiveLeads: any("admin"),
  manageNiches: any("admin"),
  manageLibrary: any("admin"),
  useFinance: any("admin", "account"),
  manageAutomation: any("admin"),
  useAds: any("admin", "ads_manager"),
  /** Projects module (companies with "projects"). */
  useProjects: any("admin", "architect_manager", "landscape_designer", "execution", "account"),
  manageProjects: any("admin"),
  useSiteVisits: any("admin", "sales", "architect_manager", "landscape_designer"),
  usePayments: any("admin", "account"),
  useMyWork: any("architect_manager", "landscape_designer", "execution"),
  /** What the people on a manager's projects are doing (admins: every project). */
  viewTeamWork: any("admin", "architect_manager"),
};

export type NavKey =
  | "dashboard" | "my-work" | "team" | "leads" | "follow-ups" | "projects" | "site-visits" | "payments" | "library" | "finance"
  | "reports" | "ads" | "automation" | "users";

const NAV_ORDER: NavKey[] = [
  "dashboard", "my-work", "team", "leads", "follow-ups", "projects", "site-visits", "payments", "library", "finance",
  "reports", "ads", "automation", "users",
];

export function navFor(roles: Roles, features: readonly string[] = []): NavKey[] {
  const list = typeof roles === "string" ? [roles] : roles;
  if (list.includes("client")) return [];
  const ads = !features.includes("no_ads");
  if (list.length === 1 && list[0] === "ads_manager") return ads ? ["ads"] : [];
  const projects = features.includes("projects");
  const items = new Set<NavKey>();
  if (can.useLeads(list) || can.useFinance(list)) items.add("dashboard");
  if (can.useLeads(list)) items.add("leads").add("follow-ups").add("library");
  if (projects) {
    if (can.useMyWork(list)) items.add("my-work");
    if (can.viewTeamWork(list)) items.add("team");
    if (can.useProjects(list)) items.add("projects");
    if (can.useSiteVisits(list)) items.add("site-visits");
    if (can.usePayments(list)) items.add("payments");
  }
  if (can.useFinance(list)) items.add("finance");
  if (can.useLeads(list) || can.useFinance(list)) items.add("reports");
  if (ads && can.useAds(list)) items.add("ads");
  if (ads && can.manageAutomation(list)) items.add("automation");
  if (can.manageUsers(list)) items.add("users");
  return NAV_ORDER.filter((k) => items.has(k));
}

/** Realtime tables a person may subscribe to (RLS still filters every event). */
export function realtimeTablesFor(roles: Roles, features: readonly string[] = []) {
  // Everyone has a bell.
  const tables = new Set<string>(["app_notifications"]);
  if (can.useLeads(roles)) {
    for (const t of ["leads", "follow_ups", "lead_activities", "niches", "library_folders", "library_files", "lead_shares", "share_events", "lead_stars", "follow_up_stars", "pipeline_stages"]) tables.add(t);
  }
  if (can.useFinance(roles)) tables.add("capital_entries").add("expenses");
  if (can.manageUsers(roles)) tables.add("profiles");
  if (features.includes("projects") && (can.useProjects(roles) || can.useSiteVisits(roles))) {
    for (const t of PROJECT_TABLES) tables.add(t);
    tables.add("project_folder_colors");
  }
  return [...tables];
}

/** Project-module tables published to Realtime (each still filtered by RLS). */
export const PROJECT_TABLES = [
  "projects", "project_members", "project_activities", "project_phases", "project_phase_items",
  "project_financials", "project_payment_milestones", "project_payments", "site_visits",
  "project_boq_revisions", "project_boq_items", "project_site_logs", "project_snags",
  "project_folders", "project_files", "project_file_versions", "project_file_comments", "project_file_events",
] as const;
