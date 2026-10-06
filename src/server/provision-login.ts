import "server-only";
import { serverEnv } from "@/lib/env";
import type { ActionResult } from "@/lib/errors";
import type { DbRole } from "@/lib/constants";
import { createAdminClient } from "@/lib/supabase/admin";

export const BAN_FOREVER = "876000h";

/**
 * Creates a username/password login. Call only after the caller was authorized for exactly this
 * role and company. The Auth user and its profile are created atomically by the
 * on_auth_user_created trigger from the app_metadata below; a missing profile rolls back.
 */
export async function provisionLogin(
  d: { username: string; displayName: string; password: string; role: DbRole; companyId?: string; adsClientId?: string; createdBy: string },
): Promise<ActionResult<{ id: string }>> {
  // Usernames are unique across all companies, so the check reads beyond the caller's own users.
  const admin = createAdminClient();
  const usernameTaken = async () => Boolean((await admin.from("profiles").select("id").eq("username", d.username).maybeSingle()).data);
  if (await usernameTaken()) return { ok: false, error: "That username is already taken.", code: "username_taken", fieldErrors: { username: ["Already taken"] } };

  const { data, error } = await admin.auth.admin.createUser({
    email: `${d.username}@${serverEnv("AUTH_LOGIN_DOMAIN")}`,
    password: d.password,
    email_confirm: true,
    app_metadata: {
      crm_username: d.username, crm_display_name: d.displayName, crm_role: d.role, crm_created_by: d.createdBy,
      ...(d.companyId ? { crm_company_id: d.companyId } : {}),
      ...(d.adsClientId ? { crm_ads_client_id: d.adsClientId } : {}),
    },
  });
  if (error || !data.user) {
    if (await usernameTaken()) return { ok: false, error: "That username is already taken.", code: "username_taken" };
    if (/password/i.test(error?.message ?? "")) return { ok: false, error: "Password does not meet the project's password policy." };
    return { ok: false, error: "Could not create the login." };
  }

  // Defensive check for partial setup (e.g. the trigger migration is missing): roll back the Auth identity.
  const { data: created } = await admin.from("profiles").select("id").eq("id", data.user.id).maybeSingle();
  if (!created) {
    await admin.auth.admin.deleteUser(data.user.id);
    return { ok: false, error: "Login setup failed and was rolled back. Check that all migrations are applied." };
  }
  return { ok: true, data: { id: data.user.id } };
}

/** Blocks (or unblocks) sign-in and token refresh at the Auth layer. RLS already denies data access. */
export async function setAuthBan(userId: string, active: boolean) {
  const { error } = await createAdminClient().auth.admin.updateUserById(userId, { ban_duration: active ? "none" : BAN_FOREVER });
  return !error;
}

export async function setAuthPassword(userId: string, password: string) {
  const { error } = await createAdminClient().auth.admin.updateUserById(userId, { password });
  return !error;
}
