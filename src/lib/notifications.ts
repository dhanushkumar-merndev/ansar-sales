import type { AppRole } from "@/lib/constants";

// Notification kinds a user can switch off in Settings. Must match
// private.notification_kinds_for() in the database, which is what actually routes messages.
export type NotificationKind =
  | "lead_created" | "lead_assigned" | "lead_closed" | "follow_up_changed" | "overdue_nag"
  | "expense_added" | "capital_added" | "recurring_expense" | "library_file_added"
  | "digest_sales" | "digest_admin" | "digest_finance" | "ads_client_new" | "ad_account_problem";

export const NOTIFICATION_KINDS: { kind: NotificationKind; label: string; description: string; roles: AppRole[] }[] = [
  { kind: "overdue_nag", label: "Overdue follow-up alerts", description: "Every 5 min, 9 AM–9 PM IST, until you complete, reschedule or tap Silence.", roles: ["admin", "sales"] },
  { kind: "lead_assigned", label: "Lead assigned to you", description: "When someone else assigns or reassigns a lead to you.", roles: ["admin", "sales"] },
  { kind: "follow_up_changed", label: "Follow-up scheduled for you", description: "When someone else schedules or reschedules a task on your lead.", roles: ["admin", "sales"] },
  { kind: "digest_sales", label: "Morning task list", description: "9 AM IST: today's tasks and anything overdue.", roles: ["admin", "sales"] },
  { kind: "lead_created", label: "New leads", description: "When a team member adds a lead.", roles: ["admin"] },
  { kind: "lead_closed", label: "Leads won or lost", description: "When a lead is marked won or lost.", roles: ["admin"] },
  { kind: "digest_admin", label: "Daily team report", description: "8 PM IST: each salesperson's leads, tasks done, overdue and wins.", roles: ["admin"] },
  { kind: "library_file_added", label: "New library files", description: "When someone uploads a file to the library.", roles: ["admin", "sales"] },
  { kind: "expense_added", label: "Expenses added", description: "When someone records an expense.", roles: ["admin", "account"] },
  { kind: "capital_added", label: "Capital added", description: "When someone records a capital contribution.", roles: ["admin", "account"] },
  { kind: "recurring_expense", label: "Monthly expenses added", description: "When a repeating expense is added automatically.", roles: ["admin", "account"] },
  { kind: "digest_finance", label: "Monthly finance summary", description: "1st of the month, 9 AM IST: last month's expenses and capital.", roles: ["admin", "account"] },
  { kind: "ads_client_new", label: "New ads clients", description: "When a won lead is handed to the ads team.", roles: ["admin", "ads_manager"] },
  { kind: "ad_account_problem", label: "Ad account problems", description: "When Meta stops returning a connected ad account's data (expired token, removed access).", roles: ["admin", "ads_manager"] },
];

export function notificationKindsFor(role: AppRole) {
  return NOTIFICATION_KINDS.filter((k) => k.roles.includes(role));
}
