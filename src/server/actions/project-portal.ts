"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { presignGet } from "@/lib/storage";
import { passwordSchema, usernameSchema } from "@/lib/validation";
import { runAction } from "@/server/action-utils";
import { provisionLogin, setAuthBan, setAuthPassword } from "@/server/provision-login";

// ----- Staff: client logins for a project (admin or the project's architect manager) -----

export async function createProjectClientLogin(input: unknown) {
  const schema = z.object({ projectId: z.uuid(), username: usernameSchema, displayName: z.string().trim().min(1).max(80), password: passwordSchema });
  return runAction(["admin", "architect_manager"], schema, input, async (d, { supabase, profile }) => {
    const { data: companyId, error } = await supabase.rpc("project_client_login_check", { p_project_id: d.projectId });
    if (error || !companyId) return dbError(error);
    return provisionLogin({
      username: d.username, displayName: d.displayName, password: d.password, role: "client",
      companyId: companyId as string, projectId: d.projectId, createdBy: profile.id,
    });
  });
}

export async function setProjectClientActive(input: unknown) {
  return runAction(["admin", "architect_manager"], z.object({ projectId: z.uuid(), userId: z.uuid(), isActive: z.boolean() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_project_client_login", { p_project_id: d.projectId, p_user_id: d.userId, p_is_active: d.isActive });
    if (error) return dbError(error);
    if (!(await setAuthBan(d.userId, d.isActive))) return { ok: false, error: "Saved, but the sign-in block could not be changed. Retry to sync it." };
    return { ok: true, data: undefined };
  });
}

export async function resetProjectClientPassword(input: unknown) {
  return runAction(["admin", "architect_manager"], z.object({ projectId: z.uuid(), userId: z.uuid(), password: passwordSchema }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_project_client_login", { p_project_id: d.projectId, p_user_id: d.userId, p_password_reset: true });
    if (error) return dbError(error);
    if (!(await setAuthPassword(d.userId, d.password))) return { ok: false, error: "Could not reset the password." };
    return { ok: true, data: undefined };
  });
}

// ----- Client: their own portal -----

export async function portalFileUrl(input: unknown) {
  return runAction(["client"], z.object({ versionId: z.uuid(), download: z.boolean().default(false) }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("portal_file_access", { p_version_id: d.versionId, p_download: d.download });
    if (error) return dbError(error);
    const f = data as { path: string; name: string };
    const url = await presignGet("projects", f.path, { expiresIn: 600, ...(d.download ? { downloadName: f.name } : {}) });
    return { ok: true, data: { url } };
  });
}

export async function portalDecision(input: unknown) {
  const schema = z.object({ versionId: z.uuid(), approve: z.boolean(), comment: z.string().trim().max(2000).optional() });
  return runAction(["client"], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("portal_file_decision", { p_version_id: d.versionId, p_approve: d.approve, p_comment: d.comment });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function portalComment(input: unknown) {
  const schema = z.object({ versionId: z.uuid(), body: z.string().trim().min(1, "Write a note").max(2000), x: z.number().min(0).max(100).nullable().default(null), y: z.number().min(0).max(100).nullable().default(null) });
  return runAction(["client"], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("portal_add_comment", { p_version_id: d.versionId, p_body: d.body, p_x: d.x ?? undefined, p_y: d.y ?? undefined });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}
