"use server";

import { z } from "zod";
import type { TablesInsert } from "@/lib/database.types";
import { dbError } from "@/lib/errors";
import { isLibraryMime, LIBRARY_MAX_BYTES, LIBRARY_MIME_TYPES } from "@/lib/library";
import { copyObject, headObject, presignGet, presignPut, recordConfirmed, recordPending } from "@/lib/storage";
import { isLibraryObjectPath, isLogoMime, LIBRARY_FILE_RE, LIBRARY_THUMB_RE, LOGO_MAX_BYTES, LOGO_MIME_TYPES } from "@/lib/storage-paths";
import { runAction } from "@/server/action-utils";

// Every Tigris URL is issued here, only after the user's own RLS client showed that the
// folder / file / company is theirs to use. Tigris itself trusts nothing but the signature.

const LEAD_ROLES = ["admin", "sales"] as const satisfies ("admin" | "sales")[];
const uploadFailed = { ok: false as const, error: "Couldn't prepare the upload. Please retry.", code: "storage" };

/** Upload URL for a new library file in a folder the user can see (not archived). */
export async function createLibraryUpload(input: unknown) {
  const schema = z.object({ folderId: z.uuid(), mime: z.string().max(100), size: z.number().int().positive() });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    if (!isLibraryMime(d.mime)) return dbError({ message: "invalid_file_type" });
    if (d.size > LIBRARY_MAX_BYTES) return { ok: false, error: "Files can be at most 25 MB.", code: "too_large" };
    const { data: folder, error } = await supabase.from("library_folders").select("id").eq("id", d.folderId).is("archived_at", null).maybeSingle();
    if (error) return dbError(error);
    if (!folder) return dbError({ message: "folder_not_found" });
    const path = `${d.folderId}/${crypto.randomUUID()}.${LIBRARY_MIME_TYPES[d.mime]}`;
    try {
      await recordPending("library", path);
      return { ok: true, data: { path, url: await presignPut("library", path, d.mime, d.size) } };
    } catch (e) {
      console.error("createLibraryUpload", e instanceof Error ? e.message : "unknown");
      return uploadFailed;
    }
  });
}

/** Upload URL for a file's WEBP preview (any lead user who can see the file). */
export async function createThumbnailUpload(input: unknown) {
  const schema = z.object({ fileId: z.uuid(), size: z.number().int().positive().max(2 * 1024 * 1024) });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    const { data: file, error } = await supabase.from("library_files").select("id, folder_id, thumb_path").eq("id", d.fileId).maybeSingle();
    if (error) return dbError(error);
    if (!file) return dbError({ message: "not_found" });
    if (file.thumb_path) return dbError({ message: "thumbnail_exists" });
    const path = `${file.folder_id}/thumbs/${crypto.randomUUID()}.webp`;
    try {
      await recordPending("library", path);
      return { ok: true, data: { path, url: await presignPut("library", path, "image/webp", d.size) } };
    } catch (e) {
      console.error("createThumbnailUpload", e instanceof Error ? e.message : "unknown");
      return uploadFailed;
    }
  });
}

/** Upload URL for a company logo (super admin). The logo is saved with updateCompany. */
export async function createLogoUpload(input: unknown) {
  const schema = z.object({ companyId: z.uuid(), mime: z.string().max(100), size: z.number().int().positive() });
  return runAction("super_admin", schema, input, async (d, { supabase }) => {
    if (!isLogoMime(d.mime)) return { ok: false, error: "Use a PNG, JPEG or WEBP image.", code: "invalid_file_type" };
    if (d.size > LOGO_MAX_BYTES) return { ok: false, error: "The logo can be at most 1 MB.", code: "too_large" };
    const { data: company, error } = await supabase.from("companies").select("id").eq("id", d.companyId).maybeSingle();
    if (error) return dbError(error);
    if (!company) return dbError({ message: "not_found" });
    const path = `${d.companyId}/${crypto.randomUUID()}.${LOGO_MIME_TYPES[d.mime]}`;
    try {
      await recordPending("logos", path);
      return { ok: true, data: { path, url: await presignPut("logos", path, d.mime, d.size) } };
    } catch (e) {
      console.error("createLogoUpload", e instanceof Error ? e.message : "unknown");
      return uploadFailed;
    }
  });
}

/**
 * Read URLs for library files and previews. Only paths of file rows the user can read
 * (RLS) are signed; anything else is silently left out. Signing is local (no network).
 */
export async function signLibraryFiles(input: unknown) {
  const schema = z.object({
    paths: z.array(z.string().max(300).refine(isLibraryObjectPath)).min(1).max(100),
    download: z.string().trim().min(1).max(200).optional(),
    expiresIn: z.number().int().min(60).max(3600).default(300),
  });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    const paths = [...new Set(d.paths)];
    const files = paths.filter((p) => LIBRARY_FILE_RE.test(p));
    const thumbs = paths.filter((p) => LIBRARY_THUMB_RE.test(p));
    const [a, b] = await Promise.all([
      files.length ? supabase.from("library_files").select("storage_path").in("storage_path", files) : null,
      thumbs.length ? supabase.from("library_files").select("thumb_path").in("thumb_path", thumbs) : null,
    ]);
    if (a?.error) return dbError(a.error);
    if (b?.error) return dbError(b.error);
    const allowed = [...(a?.data ?? []).map((r) => r.storage_path), ...(b?.data ?? []).map((r) => r.thumb_path as string)];
    const urls: Record<string, string> = {};
    for (const p of allowed) {
      urls[p] = await presignGet("library", p, { expiresIn: d.expiresIn, downloadName: d.download && allowed.length === 1 ? d.download : undefined });
    }
    return { ok: true, data: urls };
  });
}

type FileInsert = TablesInsert<"library_files">;

/** Copies one file (and its preview) into a folder, then registers the copy like an upload. */
export async function copyLibraryFile(input: unknown) {
  const schema = z.object({ fileId: z.uuid(), folderId: z.uuid() });
  return runAction([...LEAD_ROLES], schema, input, async (d, { supabase }) => {
    const [src, target] = await Promise.all([
      supabase.from("library_files").select("name, storage_path, thumb_path, mime_type, size_bytes").eq("id", d.fileId).maybeSingle(),
      supabase.from("library_folders").select("id").eq("id", d.folderId).is("archived_at", null).maybeSingle(),
    ]);
    if (src.error) return dbError(src.error);
    if (target.error) return dbError(target.error);
    if (!src.data) return dbError({ message: "not_found" });
    if (!target.data) return dbError({ message: "folder_not_found" });

    const file = src.data;
    const path = `${d.folderId}/${crypto.randomUUID()}.${file.storage_path.split(".").pop()}`;
    try {
      await recordPending("library", path);
      await copyObject("library", file.storage_path, path);
      await recordConfirmed("library", path, Number(file.size_bytes), file.mime_type);
    } catch (e) {
      console.error("copyLibraryFile", e instanceof Error ? e.message : "unknown");
      return { ok: false, error: "Couldn't copy the file. Please retry.", code: "storage" };
    }
    const { data: row, error } = await supabase
      .from("library_files")
      .insert({ folder_id: d.folderId, name: file.name, storage_path: path } as FileInsert)
      .select("id")
      .single();
    if (error) return dbError(error);

    // A missing preview is remade on the next visit, so a failure here is not reported.
    if (file.thumb_path) {
      const thumb = `${d.folderId}/thumbs/${crypto.randomUUID()}.webp`;
      try {
        await recordPending("library", thumb);
        await copyObject("library", file.thumb_path, thumb);
        const head = await headObject("library", thumb);
        if (head) {
          await recordConfirmed("library", thumb, head.size, head.contentType);
          await supabase.rpc("set_library_thumbnail", { p_file_id: row.id, p_path: thumb });
        }
      } catch {
        // ignored, see above
      }
    }
    return { ok: true, data: { id: row.id } };
  });
}
