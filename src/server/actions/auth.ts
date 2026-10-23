"use server";

import { getCurrentProfile } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import type { ActionResult } from "@/lib/errors";
import { createClient } from "@/lib/supabase/server";
import { loginSchema, passwordSchema, usernameSchema } from "@/lib/validation";

const INVALID = "Invalid username or password.";

/** Maps an immutable username to its internal Auth identity. Server-only; no public lookup endpoint. */
function authEmailFor(username: string) {
  return `${username}@${serverEnv("AUTH_LOGIN_DOMAIN")}`;
}

function safeNext(next: unknown) {
  // Same-site paths only: browsers read "/\evil.example" like "//evil.example".
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/dashboard";
}

export async function signIn(_prev: ActionResult<{ next: string }> | null, formData: FormData): Promise<ActionResult<{ next: string }>> {
  const parsed = loginSchema.safeParse({ username: formData.get("username"), password: formData.get("password") });
  if (!parsed.success) return { ok: false, error: INVALID };
  const username = usernameSchema.safeParse(parsed.data.username);
  if (!username.success) return { ok: false, error: INVALID };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: authEmailFor(username.data), password: parsed.data.password });
  if (error) {
    if (error.status === 429) return { ok: false, error: "Too many attempts. Wait a minute and try again." };
    // Banned (deactivated) users and wrong credentials get the same generic message.
    return { ok: false, error: INVALID };
  }
  const profile = await getCurrentProfile();
  if (!profile || !profile.is_active) {
    await supabase.auth.signOut();
    return { ok: false, error: INVALID };
  }
  // The form loads it fresh (not a client-side navigation): nothing from an earlier session on this tab survives.
  return { ok: true, data: { next: safeNext(formData.get("next")) } };
}

/** Ends the session; the caller loads /login fresh (src/lib/sign-out.ts). */
export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
}

export async function changePassword(input: { currentPassword: string; newPassword: string }): Promise<ActionResult> {
  const profile = await getCurrentProfile();
  if (!profile?.is_active) return { ok: false, error: "Not signed in." };
  const next = passwordSchema.safeParse(input.newPassword);
  if (!next.success) return { ok: false, error: next.error.issues[0].message };
  if (typeof input.currentPassword !== "string" || !input.currentPassword) return { ok: false, error: "Enter your current password." };

  const supabase = await createClient();
  // Re-verify the current password before changing it.
  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email: authEmailFor(profile.username),
    password: input.currentPassword,
  });
  if (verifyError) return { ok: false, error: "Current password is incorrect." };
  const { error } = await supabase.auth.updateUser({ password: next.data });
  if (error) return { ok: false, error: error.message.includes("different") ? "Choose a password different from the current one." : "Could not change password." };
  return { ok: true, data: undefined };
}
