import type { AppRole } from "@/lib/constants";

export const can = {
  manageUsers: (r: AppRole) => r === "admin",
  viewAllLeads: (r: AppRole) => r === "admin",
  useLeads: (r: AppRole) => r === "admin" || r === "sales",
  assignLeads: (r: AppRole) => r === "admin",
  archiveLeads: (r: AppRole) => r === "admin",
  manageNiches: (r: AppRole) => r === "admin",
  useFinance: (r: AppRole) => r === "admin" || r === "account",
};

export type NavKey = "dashboard" | "leads" | "follow-ups" | "finance" | "users" | "settings";

export function navFor(role: AppRole): NavKey[] {
  const items: NavKey[] = ["dashboard"];
  if (can.useLeads(role)) items.push("leads", "follow-ups");
  if (can.useFinance(role)) items.push("finance");
  if (can.manageUsers(role)) items.push("users");
  items.push("settings");
  return items;
}

/** Realtime tables a role may subscribe to (RLS still filters every event). */
export function realtimeTablesFor(role: AppRole) {
  const tables: string[] = [];
  if (can.useLeads(role)) tables.push("leads", "follow_ups", "lead_activities", "niches");
  if (can.useFinance(role)) tables.push("capital_entries", "expenses");
  if (can.manageUsers(role)) tables.push("profiles");
  return tables;
}
