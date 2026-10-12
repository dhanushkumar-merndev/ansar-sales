"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppRole } from "@/lib/constants";
import { dbError } from "@/lib/errors";
import { confirmUpload, deleteObjects, forgetObjects, isPendingUpload, presignGet, presignUploadRequest, recordPending } from "@/lib/storage";
import { PROJECT_FILE_MAX_BYTES, PROJECT_FILE_RE, PROJECT_FILE_TYPES } from "@/lib/storage-paths";
import { STAGE_COLORS } from "@/lib/stages";
import { runAction } from "@/server/action-utils";

// RLS decides per folder: the team for design folders, admin/account for payment proofs.
const ROLES: AppRole[] = ["admin", "architect_manager", "landscape_designer", "execution", "account"];

/**
 * The browser's first request for a file carries "req:<folderId>:<size>:<ext>" instead of a key;
 * the server checks access, type and quota, then picks the real object name.
 */
const signSchema = z.object({
  method: z.enum(["PUT", "POST", "DELETE", "GET"]),
  key: z.string().max(300),
  uploadId: z.string().max(1024).optional(),
  partNumber: z.number().int().min(1).max(10000).optional(),
});
const REQ_RE = /^req:([0-9a-f-]{36}):(\d{1,13}):([a-z0-9]{2,5})$/;

type Signed = { url: string; key?: string; headers?: Record<string, string> };

export async function signProjectUpload(input: unknown) {
  return runAction<typeof signSchema, Signed>(ROLES, signSchema, input, async (d, { supabase }) => {
    const start = d.key.match(REQ_RE);
    if (start) {
      const [, folderId, sizeText, ext] = start;
      const size = Number(sizeText);
      const contentType = PROJECT_FILE_TYPES[ext];
      if (!contentType) return { ok: false, error: "This file type can't be uploaded. Use PDF, images, DWG/DXF, SketchUp, video, Office or ZIP.", code: "invalid_file_type" };
      if (size <= 0 || size > PROJECT_FILE_MAX_BYTES) return { ok: false, error: "Files can be at most 5 GB.", code: "invalid_file" };
      // RLS: the folder is visible only to people who may upload into it.
      const { data: folder } = await supabase.from("project_folders").select("id, project_id").eq("id", folderId).is("archived_at", null).maybeSingle();
      if (!folder) return dbError({ message: "folder_not_found" });
      const { data: usage, error } = await supabase.rpc("project_storage_usage", { p_project_id: folder.project_id });
      if (error) return dbError(error);
      const u = usage as { used: number; quota: number };
      if (Number(u.used) + size > Number(u.quota)) return dbError({ message: "storage_full" });
      const name = `${folder.project_id}/${randomUUID()}.${ext}`;
      await recordPending("projects", name);
      const op = d.method === "PUT" ? ({ op: "put", contentType } as const) : ({ op: "create", contentType } as const);
      return { ok: true, data: { url: await presignUploadRequest("projects", name, op), key: name, headers: { "Content-Type": contentType } } };
    }

    // Later requests of a multipart upload: only for uploads this server issued and the user may reach.
    const m = d.key.match(PROJECT_FILE_RE);
    if (!m || !d.uploadId) return { ok: false, error: "Invalid upload request.", code: "invalid_file" };
    const { data: project } = await supabase.from("projects").select("id").eq("id", m[1]).maybeSingle();
    if (!project || !(await isPendingUpload("projects", d.key))) return dbError({ message: "forbidden" });
    const op = d.method === "PUT" && d.partNumber ? ({ op: "part", uploadId: d.uploadId, partNumber: d.partNumber } as const)
      : d.method === "POST" ? ({ op: "complete", uploadId: d.uploadId } as const)
      : d.method === "DELETE" ? ({ op: "abort", uploadId: d.uploadId } as const)
      : ({ op: "list", uploadId: d.uploadId } as const);
    return { ok: true, data: { url: await presignUploadRequest("projects", d.key, op) } };
  });
}

const registerSchema = z.object({
  folderId: z.uuid(),
  path: z.string().regex(PROJECT_FILE_RE),
  name: z.string().trim().min(1).max(200),
  fileId: z.uuid().optional(),
  note: z.string().trim().max(1000).optional(),
  phaseId: z.uuid().optional(),
  paymentId: z.uuid().optional(),
});

/** After the upload: confirm the object in Tigris (real size and type), then add the file or new version. */
export async function registerProjectUpload(input: unknown) {
  return runAction(ROLES, registerSchema, input, async (d, { supabase }) => {
    const ext = d.path.match(PROJECT_FILE_RE)![2];
    const problem = await confirmUpload("projects", d.path, { mimes: [PROJECT_FILE_TYPES[ext]], maxBytes: PROJECT_FILE_MAX_BYTES });
    if (problem) return dbError({ message: problem });
    const { data, error } = await supabase.rpc("register_project_file", {
      p_folder_id: d.folderId, p_path: d.path, p_name: d.name, p_file_id: d.fileId, p_note: d.note, p_phase_id: d.phaseId, p_payment_id: d.paymentId,
    });
    if (error) {
      // Over quota or not allowed after all: don't keep the bytes.
      if (/storage_full|folder_not_found|invalid_file/.test(error.message)) {
        await deleteObjects("projects", [d.path]);
        await forgetObjects("projects", [d.path]);
      }
      return dbError(error);
    }
    return { ok: true, data: data as { file_id: string; version_id: string; version_no: number } };
  });
}

/** Short-lived link to view or download one version (RLS decides whether the user may). */
export async function signProjectFileUrl(input: unknown) {
  return runAction(ROLES, z.object({ versionId: z.uuid(), download: z.boolean().default(false) }), input, async (d, { supabase }) => {
    const { data } = await supabase.from("project_file_versions").select("storage_path, original_name").eq("id", d.versionId).maybeSingle();
    if (!data) return dbError({ message: "not_found" });
    const url = await presignGet("projects", data.storage_path, { expiresIn: 600, ...(d.download ? { downloadName: data.original_name } : {}) });
    return { ok: true, data: { url } };
  });
}

export async function setFileVersionStatus(input: unknown) {
  const schema = z.object({ versionId: z.uuid(), status: z.enum(["draft", "submitted", "approved", "changes_requested"]), comment: z.string().trim().max(2000).optional() });
  return runAction(ROLES, schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_file_version_status", { p_version_id: d.versionId, p_status: d.status, p_comment: d.comment });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

export async function archiveProjectFile(input: unknown) {
  return runAction(ROLES, z.object({ id: z.uuid(), restore: z.boolean().default(false) }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_files").update({ archived_at: d.restore ? null : new Date().toISOString() }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "forbidden" });
    return { ok: true, data: undefined };
  });
}

export async function renameProjectFile(input: unknown) {
  return runAction(ROLES, z.object({ id: z.uuid(), name: z.string().trim().min(1).max(200) }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_files").update({ name: d.name }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "forbidden" });
    return { ok: true, data: undefined };
  });
}

const commentSchema = z.object({
  versionId: z.uuid(), body: z.string().trim().min(1, "Write a note").max(2000),
  page: z.number().int().min(1).max(5000).nullable().default(null),
  x: z.number().min(0).max(100).nullable().default(null), y: z.number().min(0).max(100).nullable().default(null),
  // A spot on a DWG/DXF drawing, in the drawing's own coordinates.
  cad: z.object({ x: z.number().finite().gt(-1e15).lt(1e15), y: z.number().finite().gt(-1e15).lt(1e15) }).nullable().default(null),
  color: z.enum(STAGE_COLORS).nullable().default(null),
});

/** A note on a version, optionally pinned to a spot (percent of the width/height and the PDF page, or a point on a drawing). */
export async function addFileComment(input: unknown) {
  return runAction(ROLES, commentSchema, input, async (d, { supabase, profile }) => {
    const { data: v } = await supabase.from("project_file_versions").select("project_id").eq("id", d.versionId).maybeSingle();
    if (!v) return dbError({ message: "not_found" });
    const { error } = await supabase.from("project_file_comments").insert({
      version_id: d.versionId, project_id: v.project_id, body: d.body, page: d.page, x_pct: d.x, y_pct: d.y, author_id: profile.id,
      ...(d.cad ? { cad_x: d.cad.x, cad_y: d.cad.y } : {}), ...(d.color ? { pin_color: d.color } : {}),
    });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Change a pin's colour (whoever wrote the note, the architect manager or an admin; the database checks). */
export async function setPinColor(input: unknown) {
  return runAction(ROLES, z.object({ id: z.uuid(), color: z.enum(STAGE_COLORS) }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_file_comments").update({ pin_color: d.color }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "forbidden" });
    return { ok: true, data: undefined };
  });
}

export async function resolveFileComment(input: unknown) {
  return runAction(ROLES, z.object({ id: z.uuid(), resolved: z.boolean() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_file_comments").update({ resolved_at: d.resolved ? new Date().toISOString() : null }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "forbidden" });
    return { ok: true, data: undefined };
  });
}

export async function createProjectFolder(input: unknown) {
  const schema = z.object({ projectId: z.uuid(), parentId: z.uuid().nullable(), name: z.string().trim().min(1, "Name the folder").max(80) });
  return runAction(ROLES, schema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_folders").insert({ project_id: d.projectId, parent_id: d.parentId, name: d.name, position: 100 }).select("id").single();
    if (error) {
      if (error.code === "23505") return { ok: false, error: "A folder with that name already exists here." };
      return dbError(error);
    }
    return { ok: true, data: { id: data.id } };
  });
}

/** Move a file to another folder of the same project (whoever uploaded it, or a manager; RLS and the trigger check). */
export async function moveProjectFile(input: unknown) {
  return runAction(ROLES, z.object({ id: z.uuid(), folderId: z.uuid() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_files").update({ folder_id: d.folderId }).eq("id", d.id).is("archived_at", null).select("id").maybeSingle();
    if (error?.message.startsWith("invalid_move")) return { ok: false, error: "Files can't move between Payment proofs and the design folders." };
    if (error) return dbError(error);
    if (!data) return { ok: false, error: "Only whoever uploaded the file, the architect manager or an admin can move it." };
    return { ok: true, data: undefined };
  });
}

/** Managers rename a folder they made (the standard folders keep their names). */
export async function renameProjectFolder(input: unknown) {
  const schema = z.object({ id: z.uuid(), name: z.string().trim().min(1, "Name the folder").max(80) });
  return runAction(ROLES, schema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("project_folders").update({ name: d.name }).eq("id", d.id).is("archived_at", null).select("id").maybeSingle();
    if (error) {
      if (error.code === "23505") return { ok: false, error: "A folder with that name already exists here." };
      return dbError(error);
    }
    if (!data) return dbError({ message: "forbidden" });
    return { ok: true, data: undefined };
  });
}

/** Admin or the project's architect manager: move a folder one place up or down among its siblings (standard folders too). */
export async function moveProjectFolder(input: unknown) {
  const schema = z.object({ id: z.uuid(), direction: z.enum(["up", "down"]) });
  return runAction(["admin", "architect_manager"], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("move_project_folder", { p_folder_id: d.id, p_direction: d.direction });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/**
 * Whoever made the folder, the architect manager or an admin archives it; its sub-folders and files go
 * with it, and managers can restore it or delete it for good later.
 */
export async function archiveProjectFolder(input: unknown) {
  return runAction(ROLES, z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("archive_project_folder", { p_folder_id: d.id });
    if (error) return dbError(error);
    return { ok: true, data: data as { folders: number; files: number } };
  });
}

/** Admin or the architect manager: bring an archived folder back, with what was archived with it. */
export async function restoreProjectFolder(input: unknown) {
  return runAction(["admin", "architect_manager"], z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("restore_project_folder", { p_folder_id: d.id });
    if (error) {
      if (error.code === "23505") return { ok: false, error: "A folder with that name is already there. Rename it, then restore this one." };
      return dbError(error);
    }
    return { ok: true, data: undefined };
  });
}

/**
 * Admin or the architect manager: delete an archived folder for good. The caller's own session proves
 * access; the Tigris objects go first, then the rows. Retrying after a partial failure is safe.
 */
export async function deleteProjectFolder(input: unknown) {
  return runAction(["admin", "architect_manager"], z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { data: paths, error } = await supabase.rpc("purge_project_folder_paths", { p_folder_id: d.id });
    if (error) return dbError(error);
    const names = (paths ?? []) as string[];
    try {
      for (let i = 0; i < names.length; i += 1000) {
        const batch = names.slice(i, i + 1000);
        if ((await deleteObjects("projects", batch)).length) throw new Error("delete failed");
        await forgetObjects("projects", batch);
      }
    } catch {
      return { ok: false, error: "Couldn't delete the files from storage. Please retry." };
    }
    const { data, error: purgeError } = await supabase.rpc("purge_project_folder", { p_folder_id: d.id });
    if (purgeError) return dbError(purgeError);
    return { ok: true, data: data as { folders: number; files: number } };
  });
}
