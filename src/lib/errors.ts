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
  invalid_owner: "Leads can only be assigned to an active sales user of this company.",
  not_found: "Not found, or you no longer have access.",
  not_found_or_closed: "This follow-up was already completed or cancelled.",
  follow_up_closed: "This follow-up was already completed or cancelled.",
  lead_archived: "This lead is archived.",
  last_admin: "This company needs at least one active admin.",
  feature_disabled: "Project roles need the Projects module. Ask the super admin to switch it on for this company.",
  stage_not_found: "That stage no longer exists in this company's pipeline. Refresh and pick again.",
  stage_name_taken: "A stage with that name already exists.",
  stage_has_leads: "Choose where this stage's leads should move first.",
  pipeline_incomplete: "The pipeline needs at least one open, one won and one lost stage.",
  invalid_stage_order: "The pipeline changed meanwhile. Refresh and try again.",
  category_not_found: "That category isn't in these books. Pick another.",
  category_archived: "That category is archived. Pick another or type its name to bring it back.",
  category_required: "Choose or type a category.",
  category_too_long: "Category names can be at most 40 characters.",
  category_name_taken: "A category with that name already exists.",
  not_merged: "This company already has its own books.",
  meta_secrets_required: "Enter the App secret and the system user token the first time.",
  invalid_meta_settings: "Check the App ID, Page ID, secret and token.",
  company_name_taken: "A company with that name already exists.",
  company_required: "Choose a company for this user.",
  reassign_leads_first: "Reassign this user's active leads before changing their role.",
  note_required: "Write a note.",
  invalid_merge: "Choose two different niches to merge.",
  invalid_books_merge: "Pick at least two companies, and at least one of them that may edit.",
  folder_not_found: "That folder no longer exists or was archived.",
  standard_folder: "The standard project folders can't be archived.",
  parent_archived: "The folder it was in is archived too. Restore that one first.",
  folder_not_archived: "Archive the folder first; only archived folders can be deleted.",
  file_not_uploaded: "The upload didn't finish. Try uploading the file again.",
  invalid_file_type: "Only PDF, PNG, JPEG and WEBP files can be uploaded.",
  invalid_file: "That file can't be added here.",
  invalid_share_files: "Pick between 1 and 10 different files.",
  share_file_unavailable: "One of the files was archived. Refresh and pick again.",
  invalid_expiry: "Choose when the link expires.",
  invalid_outcome: "Choose how the call went.",
  call_outcome_closed: "Call outcomes can only be added within 24 hours.",
  note_too_long: "The note is too long.",
  file_not_archived: "Archive the file before deleting it permanently.",
  folder_has_subfolders: "Archive the subfolders inside this folder first.",
  parent_folder_archived: "Restore the parent folder first.",
  folder_too_deep: "Folders can be nested at most 5 levels deep.",
  invalid_order: "The folder changed meanwhile. Refresh and try again.",
  invalid_move: "A folder can't go inside itself or its own subfolders, and files must stay inside a folder.",
  thumbnail_exists: "This file already has a preview.",
  share_link_full: "A link can hold at most 50 documents. Remove some first.",
  pin_limit: "You can pin up to 10. Unpin one first.",
  ad_account_not_disconnected: "Disconnect the ad account first; only a disconnected account's history can be deleted.",
  telegram_not_connected: "Connect Telegram first.",
  test_too_soon: "A test message was just sent. Wait a few seconds.",
  invalid_kind: "That notification type isn't available for your role.",
  ad_account_taken: "That ad account is already connected in the CRM (another company or client uses it).",
  invalid_ad_account: "Check the ad account ID and App ID (digits only, as shown in Meta).",
  duplicate_category: "A category with that name already exists on this ad account.",
  category_fixed: "A merged company's category can't be removed. Unmerge the company instead.",
  category_client: "This category belongs to an ads client. Unlink it on the client's page first.",
  category_taken: "That category already belongs to another client or a merged company. Pick another.",
  no_agency_ad_account: "Connect this company's own ad account on the Ads page first.",
  ads_source_required: "Set up an ad source first: our ad account or the client's own ad account (Ad accounts tab).",
  invalid_category: "Enter a category name.",
  already_merged: "One of those companies already shares another company's ad account.",
  ads_client_required: "Choose the client for this login.",
  invalid_ads_client: "Enter the client's name.",
  invalid_sort: "That sort isn't available.",
  invalid_status: "Choose a valid status.",
  invalid_range: "Choose a valid date range (at most about 3 years).",
  project_exists: "A project was already created from this lead.",
  already_handed_off: "This lead was already handed over to the admins.",
  invalid_member: "That person doesn't have this role in the company. Add the role in Users first.",
  owner_not_on_project: "Add this person to the project team first.",
  invalid_input: "Some details are missing or too long. Check the form and try again.",
  invalid_feature: "That module doesn't exist.",
  project_changed: "Someone else changed this meanwhile. Review the latest details and try again.",
  milestone_not_found: "That payment part no longer exists. Refresh and pick again.",
  phase_required: "Choose the phase this payment waits for.",
  invalid_view: "That view isn't available.",
  invalid_visitor: "That person can't be sent on site visits. Give them a BDM, architect manager or designer role.",
  visit_closed: "This visit is already done or cancelled.",
  boq_locked: "This BOQ was sent or approved, so it can't change. Copy it into a new revision instead.",
  future_log: "A site log can't be for a future day.",
  comment_required: "Tell the team what to change.",
  storage_full: "This project's storage is full. Remove old versions or ask the admin to raise the limit.",
  invalid_location: "The location from the phone looks wrong. Try again outside, with location turned on.",
};

/** Maps PostgREST / Postgres errors raised by our SQL to safe, readable messages. */
export function dbError<T = never>(error: { message?: string; code?: string } | null | undefined): ActionResult<T> {
  const message = error?.message ?? "";
  const key = Object.keys(MESSAGES).find((k) => message === k || message.startsWith(`${k}`));
  if (key) return { ok: false, error: MESSAGES[key], code: key };
  if (error?.code === "23505" && /niches_(company_)?normalized_name_key/.test(message)) {
    return { ok: false, error: "A niche with that name already exists.", code: "duplicate_niche" };
  }
  if (error?.code === "42501" || /row-level security|permission denied/i.test(message)) {
    return { ok: false, error: MESSAGES.forbidden, code: "forbidden" };
  }
  if (error?.code === "23514" || error?.code === "22023" || error?.code === "22P02") {
    return { ok: false, error: "Some values are invalid. Check the form and try again.", code: "invalid" };
  }
  // A column or function the app expects isn't in the database yet (migrations not applied).
  // 42P17: a policy fixed by a later migration (e.g. sub-folders before 20261008001400).
  if (error?.code === "42703" || error?.code === "42883" || error?.code === "42P17" || error?.code === "PGRST202" || error?.code === "PGRST204") {
    return { ok: false, error: "This needs a database update that isn't applied yet. Ask your admin to apply the latest migrations.", code: "schema_outdated" };
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
