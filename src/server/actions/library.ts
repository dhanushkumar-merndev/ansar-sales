"use server";

import { z } from "zod";
import type { TablesInsert } from "@/lib/database.types";
import { dbError } from "@/lib/errors";
import { STORAGE_PATH_RE } from "@/lib/library";
import { runAction } from "@/server/action-utils";

const LEAD_ROLES = ["admin", "sales"] as const satisfies ("admin" | "sales")[];
const folderName = z.string().trim().min(1, "Enter a folder name").max(80, "At most 80 characters");
// created_by (and for files mime_type/size_bytes) are filled in by the database trigger.
type FolderInsert = TablesInsert<"library_folders">;
type FileInsert = TablesInsert<"library_files">;

function folderError(error: { message?: string; code?: string }) {
  if (error.code === "23505" && /library_folders_active_name_key/.test(error.message ?? "")) {
    return { ok: false as const, error: "A folder with that name already exists.", code: "duplicate_folder", fieldErrors: { name: ["Already exists"] } };
  }
  return dbError(error);
}

export async function createFolder(input: unknown) {
  return runAction([...LEAD_ROLES], z.object({ name: folderName, parentId: z.uuid().nullish() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase
      .from("library_folders")
      .insert({ name: d.name, parent_id: d.parentId ?? null } as FolderInsert)
      .select("id")
      .single();
    if (error) return folderError(error);
    return { ok: true, data: { id: data.id } };
  });
}

export async function renameFolder(input: unknown) {
  return runAction(["admin"], z.object({ id: z.uuid(), name: folderName }), input, async (d, { supabase }) => {
    const { data, error } = await supabase.from("library_folders").update({ name: d.name }).eq("id", d.id).select("id").maybeSingle();
    if (error) return folderError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: undefined };
  });
}

export async function setFolderArchived(input: unknown) {
  return runAction(["admin"], z.object({ id: z.uuid(), archived: z.boolean() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase
      .from("library_folders")
      .update({ archived_at: d.archived ? new Date().toISOString() : null })
      .eq("id", d.id)
      .select("id")
      .maybeSingle();
    if (error) return folderError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: undefined };
  });
}

/** Called after the browser uploaded the object; the database verifies the object, folder, size and type. */
export async function registerLibraryFile(input: unknown) {
  const schema = z.object({
    folderId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    storagePath: z.string().regex(STORAGE_PATH_RE),
  });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    if (!d.storagePath.startsWith(`${d.folderId}/`)) return { ok: false, error: "Invalid upload path.", code: "invalid_file" };
    const { data, error } = await supabase
      .from("library_files")
      .insert({ folder_id: d.folderId, name: d.name, storage_path: d.storagePath } as FileInsert)
      .select("id")
      .single();
    if (error) return dbError(error);
    return { ok: true, data: { id: data.id } };
  });
}

export async function setFileArchived(input: unknown) {
  return runAction(["admin"], z.object({ id: z.uuid(), archived: z.boolean() }), input, async (d, { supabase }) => {
    const { data, error } = await supabase
      .from("library_files")
      .update({ archived_at: d.archived ? new Date().toISOString() : null })
      .eq("id", d.id)
      .select("id")
      .maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    return { ok: true, data: undefined };
  });
}

/** Links a browser-made preview image to a file (once). */
export async function setLibraryThumbnail(input: unknown) {
  const schema = z.object({ fileId: z.uuid(), path: z.string().regex(/^[0-9a-f-]{36}\/thumbs\/[0-9a-f-]{36}\.webp$/) });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    const { error } = await supabase.rpc("set_library_thumbnail", { p_file_id: d.fileId, p_path: d.path });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Admin rearranges one page of a folder's items; the database hands those items their existing slots in the new order. */
export async function reorderLibraryItems(input: unknown) {
  const schema = z.object({
    parentId: z.uuid().nullable(),
    items: z.array(z.object({ kind: z.enum(["folder", "file"]), id: z.uuid() })).min(1).max(100),
  });
  return runAction(["admin"], schema, input, async (d, { supabase }) => {
    // p_parent_id is null for the top level; the generated type doesn't model the null default.
    const { error } = await supabase.rpc("reorder_library_items", { p_parent_id: d.parentId as string, p_items: d.items });
    if (error) return dbError(error);
    return { ok: true, data: undefined };
  });
}

/** Admin moves folders and files into another folder (null = top level, folders only). */
export async function moveLibraryItems(input: unknown) {
  const schema = z.object({
    targetFolderId: z.uuid().nullable(),
    items: z.array(z.object({ kind: z.enum(["folder", "file"]), id: z.uuid() })).min(1).max(100),
  });
  return runAction(["admin"], schema, input, async (d, { supabase }) => {
    // p_target_folder_id is null for the top level; the generated type doesn't model it.
    const { data, error } = await supabase.rpc("move_library_items", { p_target_folder_id: d.targetFolderId as string, p_items: d.items });
    if (error) {
      if (error.code === "23505" && /library_folders_active_name_key/.test(error.message ?? "")) {
        return { ok: false, error: "A folder with that name already exists there.", code: "duplicate_folder" };
      }
      return dbError(error);
    }
    return { ok: true, data: { moved: data ?? 0 } };
  });
}
