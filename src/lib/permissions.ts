import type { AppRole } from "@/lib/constants";

export const can = {
  manageUsers: (r: AppRole) => r === "admin",
  viewAllLeads: (r: AppRole) => r === "admin",
  useLeads: (r: AppRole) => r === "admin" || r === "sales",
  assignLeads: (r: AppRole) => r === "admin",
  archiveLeads: (r: AppRole) => r === "admin",
  manageNiches: (r: AppRole) => r === "admin",
  manageLibrary: (r: AppRole) => r === "admin",
  useFinance: (r: AppRole) => r === "admin" || r === "account",
};

export type NavKey = "dashboard" | "leads" | "follow-ups" | "library" | "finance" | "reports" | "users";

export function navFor(role: AppRole): NavKey[] {
  const items: NavKey[] = ["dashboard"];
  if (can.useLeads(role)) items.push("leads", "follow-ups", "library");
  if (can.useFinance(role)) items.push("finance");
  items.push("reports");
  if (can.manageUsers(role)) items.push("users");
  return items;
}

/** Realtime tables a role may subscribe to (RLS still filters every event). */
export function realtimeTablesFor(role: AppRole) {
  const tables: string[] = [];
  if (can.useLeads(role)) tables.push("leads", "follow_ups", "lead_activities", "niches", "library_folders", "library_files", "lead_shares", "share_events", "lead_stars", "follow_up_stars");
  if (can.useFinance(role)) tables.push("capital_entries", "expenses");
  if (can.manageUsers(role)) tables.push("profiles");
  return tables;
}
