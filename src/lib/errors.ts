export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; fieldErrors?: Record<string, string[]> };

const MESSAGES: Record<string, string> = {
  forbidden: "You don't have permission to do that.",
  duplicate_phone: "A lead with this phone number already exists.",
  version_conflict: "This lead was changed by someone else. Review the latest details and try again.",
  niche_archived: "That niche has been archived by an admin. Pick another niche.",
  niche_required: "Choose or create a niche.",
  niche_not_found: "That niche no longer exists.",
  niche_too_long: "Niche names can be at most 60 characters.",
  invalid_owner: "Leads can only be assigned to an active sales user.",
  not_found: "Not found, or you no longer have access.",
  not_found_or_closed: "This follow-up was already completed or cancelled.",
  follow_up_closed: "This follow-up was already completed or cancelled.",
  lead_archived: "This lead is archived.",
  last_admin: "At least one active admin is required.",
  reassign_leads_first: "Reassign this user's active leads before changing their role.",
  note_required: "Write a note.",
  invalid_merge: "Choose two different niches to merge.",
};

/** Maps PostgREST / Postgres errors raised by our SQL to safe, readable messages. */
export function dbError<T = never>(error: { message?: string; code?: string } | null | undefined): ActionResult<T> {
  const message = error?.message ?? "";
  const key = Object.keys(MESSAGES).find((k) => message === k || message.startsWith(`${k}`));
  if (key) return { ok: false, error: MESSAGES[key], code: key };
  if (error?.code === "23505" && /niches_normalized_name_key/.test(message)) {
    return { ok: false, error: "A niche with that name already exists.", code: "duplicate_niche" };
  }
  if (error?.code === "42501" || /row-level security|permission denied/i.test(message)) {
    return { ok: false, error: MESSAGES.forbidden, code: "forbidden" };
  }
  if (error?.code === "23514" || error?.code === "22023" || error?.code === "22P02") {
    return { ok: false, error: "Some values are invalid. Check the form and try again.", code: "invalid" };
  }
  return { ok: false, error: "Something went wrong. Please try again.", code: "unknown" };
}

export function validationError<T = never>(issues: { path: PropertyKey[]; message: string }[]): ActionResult<T> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".") || "_";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return { ok: false, error: issues[0]?.message ?? "Invalid input", code: "validation", fieldErrors };
}

export function friendlyReadError(error: unknown) {
  const message = (error as { message?: string })?.message ?? "";
  if (/forbidden|permission/i.test(message)) return "You don't have access to this data.";
  if (/fetch|network/i.test(message)) return "Network problem. Check your connection.";
  return "Couldn't load data. Please retry.";
}
