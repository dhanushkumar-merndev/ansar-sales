import type { LeadOutcome, ReminderState } from "@/lib/constants";

export type NicheOption = { id: string; name: string };

export type LeadListItem = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  status: LeadOutcome;
  stage_id: string;
  source: "manual" | "facebook";
  niche: NicheOption;
  owner: { id: string; display_name: string };
  next_follow_up_at: string | null;
  overdue: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  starred: boolean;
  pinned_at: string | null;
  version: number;
};

export type FollowUpListItem = {
  id: string;
  task: string;
  due_at: string;
  state: "pending" | "completed" | "cancelled";
  outcome: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  overdue: boolean;
  lead: { id: string; name: string; phone: string; status: LeadOutcome; stage_id: string };
  assignee: { id: string; display_name: string };
  reminder: { state: ReminderState; attempts: number; last_error: string | null; sent_at: string | null } | null;
  starred: boolean;
  pinned_at: string | null;
};

export type UserListItem = {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "sales" | "account";
  is_active: boolean;
  created_at: string;
  owned_active_leads: number;
};

export type StaffOption = { id: string; display_name: string; role: string };
