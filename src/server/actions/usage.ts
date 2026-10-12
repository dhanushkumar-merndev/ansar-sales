"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { deleteObjects, forgetObjects } from "@/lib/storage";
import { runAction } from "@/server/action-utils";

/**
 * Permanently deletes an archived library file. The admin's own session (RLS) proves the
 * file is visible and archived; then its Tigris objects are removed and its records purged.
 * Retrying after a partial failure is safe (deleting a missing object succeeds).
 */
export async function deleteArchivedFile(input: unknown) {
  return runAction("super_admin", z.object({ id: z.uuid() }), input, async (d, { supabase }) => {
    const { data: file, error } = await supabase.from("library_files").select("id, storage_path, thumb_path, archived_at, size_bytes").eq("id", d.id).maybeSingle();
    if (error) return dbError(error);
    if (!file) return dbError({ message: "not_found" });
    if (!file.archived_at) return dbError({ message: "file_not_archived" });

    const paths = [file.storage_path, ...(file.thumb_path ? [file.thumb_path] : [])];
    try {
      if ((await deleteObjects("library", paths)).length) throw new Error("delete failed");
      await forgetObjects("library", paths);
    } catch {
      return { ok: false, error: "Couldn't delete the file from storage. Please retry." };
    }
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
    let failed: Set<string>;
    try {
      failed = new Set(await deleteObjects("library", items.map((i) => i.path)));
      await forgetObjects("library", items.map((i) => i.path).filter((p) => !failed.has(p)));
    } catch {
      return { ok: false, error: "Couldn't clean up the uploads. Please retry." };
    }
    const freed = items.filter((i) => !failed.has(i.path));
    return { ok: true, data: { files: freed.length, freedBytes: freed.reduce((sum, i) => sum + Number(i.bytes), 0) } };
  });
}
