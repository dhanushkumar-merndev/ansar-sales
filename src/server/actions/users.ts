"use server";

import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { dbError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAction } from "@/server/action-utils";
import { createUserSchema, passwordSchema, updateUserSchema } from "@/lib/validation";

const BAN_FOREVER = "876000h";

/** Admin-only. Auth user + profile are created atomically by the on_auth_user_created trigger. */
export async function createUser(input: unknown) {
  return runAction(["admin"], createUserSchema, input, async (d, { supabase, profile }) => {
    const { data: existing } = await supabase.from("profiles").select("id").eq("username", d.username).maybeSingle();
    if (existing) return { ok: false, error: "That username is already taken.", code: "username_taken", fieldErrors: { username: ["Already taken"] } };

    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.createUser({
      email: `${d.username}@${serverEnv("AUTH_LOGIN_DOMAIN")}`,
      password: d.password,
      email_confirm: true,
      app_metadata: { crm_username: d.username, crm_display_name: d.displayName, crm_role: d.role, crm_created_by: profile.id },
    });
    if (error || !data.user) {
      const { data: raced } = await supabase.from("profiles").select("id").eq("username", d.username).maybeSingle();
      if (raced) return { ok: false, error: "That username is already taken.", code: "username_taken" };
      if (/password/i.test(error?.message ?? "")) return { ok: false, error: "Password does not meet the project's password policy." };
      return { ok: false, error: "Could not create the user." };
    }

    // Defensive check for partial setup (e.g. the trigger migration is missing): roll back the Auth identity.
    const { data: created } = await supabase.from("profiles").select("id").eq("id", data.user.id).maybeSingle();
    if (!created) {
      await admin.auth.admin.deleteUser(data.user.id);
      return { ok: false, error: "User setup failed and was rolled back. Check that all migrations are applied." };
    }
    return { ok: true, data: { id: data.user.id } };
  });
}

export async function updateUser(input: unknown) {
  return runAction(["admin"], updateUserSchema, input, async (d, { supabase }) => {
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
      const { error: banError } = await createAdminClient().auth.admin.updateUserById(d.id, {
        ban_duration: d.isActive ? "none" : BAN_FOREVER,
      });
      if (banError) {
        return { ok: false, error: "Profile updated, but the sign-in block could not be changed. Retry to sync it.", code: "auth_sync" };
      }
    }
    return { ok: true, data: { isActive: data.is_active } };
  });
}

export async function resetUserPassword(input: unknown) {
  return runAction(["admin"], z.object({ id: z.uuid(), password: passwordSchema }), input, async (d, { supabase }) => {
    const { data: target } = await supabase.from("profiles").select("id").eq("id", d.id).maybeSingle();
    if (!target) return dbError({ message: "not_found" });
    const { error } = await createAdminClient().auth.admin.updateUserById(d.id, { password: d.password });
    if (error) return { ok: false, error: "Could not reset the password." };
    await supabase.rpc("admin_log_password_reset", { p_user_id: d.id });
    return { ok: true, data: undefined };
  });
}
