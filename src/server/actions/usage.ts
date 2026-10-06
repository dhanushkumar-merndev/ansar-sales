"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { LIBRARY_BUCKET } from "@/lib/library";
import { runAction } from "@/server/action-utils";

/**
 * Permanently deletes an archived library file. The Storage object is removed first
 * with the admin's own session (the RLS delete policy only allows archived files);
 * then its records are purged. Retrying after a partial failure is safe.
 */
export async function deleteArchivedFile(input: unknown) {
  return runAction("super_admin", z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { data: file, error } = await supabase.from("library_files").select("id, storage_path, thumb_path, archived_at, size_bytes").eq("id", d.id).maybeSingle();
    if (error) return dbError(error);
    if (!file) return dbError({ message: "not_found" });
    if (!file.archived_at) return dbError({ message: "file_not_archived" });

    const { error: removeError } = await supabase.storage.from(LIBRARY_BUCKET).remove([file.storage_path, ...(file.thumb_path ? [file.thumb_path] : [])]);
    if (removeError) return { ok: false, error: "Couldn't delete the file from storage. Please retry." };
    const { error: purgeError } = await supabase.rpc("admin_purge_library_file", { p_file_id: file.id });
    if (purgeError) return dbError(purgeError);
    return { ok: true, data: { freedBytes: Number(file.size_bytes) } };
  });
}

/** Removes uploads that never got registered (older than an hour), at most 100 per run. */
export async function cleanUnregisteredUploads(input: unknown) {
  return runAction("super_admin", z.object({}).strict(), input ?? {}, async (_d, { supabase }) => {
    const { data, error } = await supabase.rpc("admin_unregistered_uploads", { p_limit: 100 });
    if (error) return dbError(error);
    const items = (data ?? []) as { path: string; bytes: number }[];
    if (!items.length) return { ok: true, data: { files: 0, freedBytes: 0 } };
    const { data: removed, error: removeError } = await supabase.storage.from(LIBRARY_BUCKET).remove(items.map((i) => i.path));
    if (removeError) return { ok: false, error: "Couldn't clean up the uploads. Please retry." };
    const removedPaths = new Set((removed ?? []).map((o) => o.name));
    const freed = items.filter((i) => removedPaths.has(i.path));
    return { ok: true, data: { files: freed.length, freedBytes: freed.reduce((sum, i) => sum + Number(i.bytes), 0) } };
  });
}
