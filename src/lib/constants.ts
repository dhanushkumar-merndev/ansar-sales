import { Constants, type Enums } from "@/lib/database.types";

/** Role stored on the profile. A super admin works inside one company at a time as its admin. */
export type DbRole = Enums<"app_role">;
/**
 * Effective role inside the current company (a super admin is "admin" there). "ads_manager" works
 * across the companies the super admin assigns; "client" is an ads client's read-only portal login.
 */
export type AppRole = Exclude<DbRole, "super_admin">;
/** A lead's outcome: the kind of its current pipeline stage. */
export type LeadOutcome = Enums<"lead_outcome">;
/** Expense categories belong to a set of books and can be added while saving; entries carry the category's name. */
export type ExpenseCategory = string;
export type ReminderState = Enums<"reminder_state">;

/** Roles an admin can give a user. The super admin is created only by the bootstrap script. */
export const ROLES = ["admin", "sales", "account"] as const satisfies readonly AppRole[];
export const LEAD_OUTCOMES = Constants.public.Enums.lead_outcome;

export const ROLE_LABELS: Record<AppRole, string> = {
  admin: "Admin", sales: "Sales", account: "Account", ads_manager: "Ads manager", client: "Client",
};

/** Where each role lands after signing in (and when it opens a page it can't use). */
export function homePathFor(role: AppRole) {
  return role === "client" ? "/portal" : role === "ads_manager" ? "/ads" : "/dashboard";
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
