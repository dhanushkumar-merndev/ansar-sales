import type { AppRole } from "@/lib/constants";

// Notification kinds a user can switch off in Settings. Must match
// private.notification_kinds_for() in the database, which is what actually routes messages.
export type NotificationKind =
  | "lead_created" | "lead_assigned" | "lead_closed" | "follow_up_changed" | "overdue_nag"
  | "expense_added" | "capital_added" | "recurring_expense" | "library_file_added"
  | "digest_sales" | "digest_admin" | "digest_finance" | "ads_client_new" | "ad_account_problem"
  | "lead_handed_off" | "project_assigned" | "phase_assigned" | "phase_due_soon" | "phase_overdue" | "phase_submitted"
  | "phase_changes" | "project_at_risk" | "site_visit_reminder" | "payment_due" | "payment_overdue" | "payment_received"
  | "boq_status" | "snag_assigned" | "project_completed" | "client_feedback";

const TEAM: AppRole[] = ["admin", "architect_manager", "landscape_designer", "execution"];

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
  // Projects module (Star Gardens). These only fire in companies with Projects switched on.
  { kind: "lead_handed_off", label: "Leads handed over", description: "When a BDM hands an interested lead to the admins.", roles: ["admin"] },
  { kind: "project_assigned", label: "Added to a project", description: "When you join a project team.", roles: TEAM },
  { kind: "phase_assigned", label: "Phase assigned to you", description: "When a timeline phase is given to you.", roles: TEAM },
  { kind: "phase_due_soon", label: "Deadline tomorrow", description: "9 AM IST, the day before a phase deadline (you own it or manage the project).", roles: TEAM },
  { kind: "phase_overdue", label: "Late phases", description: "10 AM IST, once a day while a phase is past its deadline.", roles: TEAM },
  { kind: "phase_submitted", label: "Phases sent for review", description: "When a designer sends a phase for your review.", roles: ["admin", "architect_manager"] },
  { kind: "phase_changes", label: "Changes requested", description: "When changes are requested on your phase.", roles: ["admin", "landscape_designer"] },
  { kind: "project_at_risk", label: "Projects at risk", description: "When a project passes its end date, or a phase runs past it.", roles: ["admin", "architect_manager"] },
  { kind: "site_visit_reminder", label: "Site visit reminders", description: "About an hour before a site visit you're going on.", roles: ["admin", "sales", "architect_manager", "landscape_designer"] },
  { kind: "payment_due", label: "Payments due", description: "9 AM IST, when a client's payment part falls due.", roles: ["admin", "account"] },
  { kind: "payment_overdue", label: "Payments overdue", description: "Monday 10 AM IST, for each part more than a week late.", roles: ["admin", "account"] },
  { kind: "payment_received", label: "Payments received", description: "When Accounts records money received from a client.", roles: ["admin", "account"] },
  { kind: "boq_status", label: "BOQ sent or approved", description: "When a BOQ revision is sent to or approved by the client.", roles: TEAM },
  { kind: "snag_assigned", label: "Snags for you", description: "When a snag is given to you to fix.", roles: TEAM },
  { kind: "client_feedback", label: "Client approvals and change requests", description: "When the client approves a file or asks for changes in the portal.", roles: TEAM },
  { kind: "project_completed", label: "Projects completed", description: "When a project you're on is marked completed.", roles: TEAM },
];

const PROJECT_KINDS = new Set<NotificationKind>([
  "lead_handed_off", "project_assigned", "phase_assigned", "phase_due_soon", "phase_overdue", "phase_submitted", "phase_changes",
  "project_at_risk", "site_visit_reminder", "payment_due", "payment_overdue", "payment_received", "boq_status", "snag_assigned", "project_completed",
  "client_feedback",
]);

/** Kinds for one role or for every role a person has (project alerts only where the module is on). */
export function notificationKindsFor(roles: AppRole | readonly AppRole[], features: readonly string[] = []) {
  const list = typeof roles === "string" ? [roles] : roles;
  const projects = features.includes("projects");
  return NOTIFICATION_KINDS.filter((k) => k.roles.some((r) => list.includes(r)) && (projects || !PROJECT_KINDS.has(k.kind)));
}
