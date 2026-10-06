"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { createUserSchema, passwordSchema, updateUserSchema } from "@/lib/validation";
import { runAction } from "@/server/action-utils";
import { provisionLogin, setAuthBan, setAuthPassword } from "@/server/provision-login";

/** Admin-only. The new user joins the company the admin works in (the super admin's active company). */
export async function createUser(input: unknown) {
  return runAction(["admin"], createUserSchema, input, (d, { profile }) =>
    provisionLogin({ username: d.username, displayName: d.displayName, password: d.password, role: d.role, companyId: profile.company.id, createdBy: profile.id }));
}

export async function updateUser(input: unknown) {
  return runAction(["admin"], updateUserSchema, input, async (d, { supabase, profile }) => {
    if (d.id === profile.id) return { ok: false, error: "You can't change your own role or access here. Ask another admin." };
    // Profile change first: the database enforces the last-admin and lead-ownership rules.
    const { data, error } = await supabase.rpc("admin_update_user", {
      p_user_id: d.id,
      p_display_name: d.displayName,
      p_role: d.role,
      p_is_active: d.isActive,
    });
    if (error) return dbError(error);
    if (d.isActive !== undefined) {
      // Also block sign-in / token refresh at the Auth layer. RLS already denies data access.
      if (!(await setAuthBan(d.id, d.isActive))) {
        return { ok: false, error: "Profile updated, but the sign-in block could not be changed. Retry to sync it.", code: "auth_sync" };
      }
    }
    return { ok: true, data: { isActive: data.is_active } };
  });
}

export async function resetUserPassword(input: unknown) {
  return runAction(["admin"], z.object({ id: z.uuid(), password: passwordSchema }), input, async (d, { supabase, profile }) => {
    if (d.id === profile.id) return { ok: false, error: "Change your own password from Settings." };
    // Authorize first: the database only allows a target in the admin's current company
    // (never the super admin), and records the reset in the audit log.
    const { error: authError } = await supabase.rpc("admin_log_password_reset", { p_user_id: d.id });
    if (authError) return dbError(authError.code === "42501" ? { message: "not_found" } : authError);
    if (!(await setAuthPassword(d.id, d.password))) return { ok: false, error: "Could not reset the password." };
    return { ok: true, data: undefined };
  });
}
