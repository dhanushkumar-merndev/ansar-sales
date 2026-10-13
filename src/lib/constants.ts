import { Constants, type Enums } from "@/lib/database.types";

/** Role stored on the profile. A super admin works inside one company at a time as its admin. */
export type DbRole = Enums<"app_role">;
/**
 * Effective role inside the current company (a super admin is "admin" there). "ads_manager" works
 * across the companies the super admin assigns; "client" is a read-only portal login.
 * architect_manager / landscape_designer / execution exist only in companies with the projects module.
 */
export type AppRole = Exclude<DbRole, "super_admin">;
/** A lead's outcome: the kind of its current pipeline stage. */
export type LeadOutcome = Enums<"lead_outcome">;
/** Expense categories belong to a set of books and can be added while saving; entries carry the category's name. */
export type ExpenseCategory = string;
export type ReminderState = Enums<"reminder_state">;

/** Roles an admin can give a user. The super admin is created only by the bootstrap script. */
export const ROLES = ["admin", "sales", "account"] as const satisfies readonly AppRole[];
/** Extra roles for companies with the projects module (Star Gardens). */
export const PROJECT_ROLES = ["architect_manager", "landscape_designer", "execution"] as const satisfies readonly AppRole[];
export type ProjectRole = (typeof PROJECT_ROLES)[number];
/** Every role an admin can assign, as a main role or an extra ("Also works as") role. */
export const ASSIGNABLE_ROLES = [...ROLES, ...PROJECT_ROLES] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
export const isProjectRole = (r: AppRole): r is ProjectRole => (PROJECT_ROLES as readonly AppRole[]).includes(r);

/** Optional modules a super admin switches on per company. */
/** "no_ads": the company runs no ads of its own (Star Growth Hub does them), so Ads and Automation are off. */
export const COMPANY_FEATURES = ["projects", "no_ads"] as const;
/** "client_workspace": an ads client's own CRM (set by the database when it is created, never switched by hand). */
export type CompanyFeature = (typeof COMPANY_FEATURES)[number] | "client_workspace";
export const LEAD_OUTCOMES = Constants.public.Enums.lead_outcome;

export const ROLE_LABELS: Record<AppRole, string> = {
  admin: "Admin", sales: "Sales", account: "Account", ads_manager: "Ads manager", client: "Client",
  architect_manager: "Architect manager", landscape_designer: "Landscape designer", execution: "Execution manager",
};

/** A role's name in a company: project companies call their salespeople BDMs. */
export function roleLabel(role: AppRole, features: readonly string[] = []) {
  return role === "sales" && features.includes("projects") ? "BDM" : ROLE_LABELS[role];
}

/** All of a person's roles as one label, e.g. "BDM · Account". */
export function rolesLabel(roles: readonly AppRole[], features: readonly string[] = []) {
  return roles.map((r) => roleLabel(r, features)).join(" · ");
}

/** Where each role lands after signing in (and when it opens a page it can't use). */
export function homePathFor(role: AppRole) {
  if (role === "client") return "/portal";
  if (role === "ads_manager") return "/ads";
  if (role === "landscape_designer" || role === "execution") return "/my-work";
  if (isProjectRole(role)) return "/projects";
  return "/dashboard";
}
export const SUPER_ADMIN_LABEL = "Super admin";

export const OUTCOME_LABELS: Record<LeadOutcome, string> = { open: "Open", won: "Won", lost: "Lost" };

const LEGACY_CATEGORY_LABELS: Record<string, string> = {
  salary: "Salary", rent: "Rent", software: "Software", marketing: "Marketing", utilities: "Utilities", miscellaneous: "Miscellaneous",
};
/** A category's display name. History written before categories became editable stored lowercase keys. */
export const categoryLabel = (c: string | null | undefined) => (c ? (LEGACY_CATEGORY_LABELS[c] ?? c) : "—");

export const PAYMENT_MODES = ["cash", "upi", "bank_transfer", "cheque", "card", "other"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  cash: "Cash", upi: "UPI", bank_transfer: "Bank transfer", cheque: "Cheque", card: "Card", other: "Other",
};

export const PAGE_SIZES = [20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const SEARCH_DEBOUNCE_MS = 300;
export const REALTIME_DEBOUNCE_MS = 350;
