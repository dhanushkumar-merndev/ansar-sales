import { Constants, type Enums } from "@/lib/database.types";

export type AppRole = Enums<"app_role">;
export type LeadStatus = Enums<"lead_status">;
export type ExpenseCategory = Enums<"expense_category">;
export type ReminderState = Enums<"reminder_state">;

export const ROLES = Constants.public.Enums.app_role;
export const LEAD_STATUSES = Constants.public.Enums.lead_status;
export const EXPENSE_CATEGORIES = Constants.public.Enums.expense_category;

export const ROLE_LABELS: Record<AppRole, string> = { admin: "Admin", sales: "Sales", account: "Account" };

export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  interested: "Interested",
  proposal_sent: "Proposal sent",
  won: "Won",
  lost: "Lost",
};

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  salary: "Salary",
  rent: "Rent",
  software: "Software",
  marketing: "Marketing",
  utilities: "Utilities",
  miscellaneous: "Miscellaneous",
};

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
