"use client";

import { toast } from "sonner";
import { MULTIPART_ABOVE, UploadCancelled as Cancelled, uploadObject } from "@/lib/multipart-upload";
import { formatBytes } from "@/lib/projects";
import { PROJECT_FILE_MAX_BYTES, PROJECT_FILE_TYPES, projectFileExt } from "@/lib/storage-paths";
import { registerProjectUpload, signProjectUpload } from "@/server/actions/project-files";

export const PROJECT_FILE_ACCEPT = Object.keys(PROJECT_FILE_TYPES).map((e) => `.${e}`).join(",");

/** Uploads one file straight to Tigris (the server signs each request after checking access, type and quota). Returns its key. */
function send(folderId: string, file: File, signal: AbortSignal, onProgress: (sent: number) => void) {
  return uploadObject({ file, first: `req:${folderId}:${file.size}:${projectFileExt(file.name)}`, sign: signProjectUpload, signal, onProgress });
}

/**
 * Uploads files into a project folder one by one, with a single progress toast (like the Library).
 * With `fileId` the one file becomes that file's new version.
 */
export async function uploadProjectFiles(folderId: string, picked: File[], opts: { folderName?: string; fileId?: string; onUploaded?: () => void } = {}) {
  const files = opts.fileId ? picked.slice(0, 1) : picked;
  if (!files.length) return;
  const into = opts.fileId ? " as a new version" : opts.folderName ? ` to ${opts.folderName}` : "";
  const ctrl = new AbortController();
  const total = files.reduce((s, f) => s + f.size, 0);
  let doneBytes = 0;
  const cancel = { label: "Cancel", onClick: () => ctrl.abort() };
  const label = (i: number, sent: number) => {
    const pct = total ? Math.floor(((doneBytes + sent) / total) * 100) : 0;
    const what = files.length === 1 ? files[0].name : `${i + 1} of ${files.length}`;
    return `Uploading ${what}${into}… ${pct}%${total > MULTIPART_ABOVE ? ` (${formatBytes(doneBytes + sent)} of ${formatBytes(total)})` : ""}`;
  };
  const toastId = toast.loading(label(0, 0), { action: cancel, duration: Infinity });
  const warn = (e: BeforeUnloadEvent) => e.preventDefault();
  window.addEventListener("beforeunload", warn);
  const failed: string[] = [];
  let ok = 0;
  let last = 0;

  try {
    for (const [i, file] of files.entries()) {
      if (ctrl.signal.aborted) break;
      const ext = projectFileExt(file.name);
      if (!PROJECT_FILE_TYPES[ext]) { failed.push(`${file.name}: this type can't be uploaded`); doneBytes += file.size; continue; }
      if (file.size > PROJECT_FILE_MAX_BYTES) { failed.push(`${file.name}: larger than 5 GB`); doneBytes += file.size; continue; }
      if (file.size === 0) { failed.push(`${file.name}: empty file`); continue; }
      try {
        const key = await send(folderId, file, ctrl.signal, (sent) => {
          const now = Date.now();
          if (now - last < 200) return;
          last = now;
          toast.loading(label(i, sent), { id: toastId, action: cancel, duration: Infinity });
        });
        doneBytes += file.size;
        toast.loading(label(i, 0), { id: toastId, action: cancel, duration: Infinity });
        const r = await registerProjectUpload({ folderId, path: key, name: file.name.slice(0, 200), fileId: opts.fileId });
        if (!r.ok) { failed.push(`${file.name}: ${r.error}`); continue; }
        ok++;
        opts.onUploaded?.();
      } catch (e) {
        if (e instanceof Cancelled || ctrl.signal.aborted) break;
        failed.push(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
        doneBytes += file.size;
      }
    }
  } finally {
    window.removeEventListener("beforeunload", warn);
  }

  const done = { id: toastId, action: undefined, duration: undefined };
  if (ctrl.signal.aborted) toast.info(ok ? `Stopped — ${ok} uploaded` : "Upload cancelled", done);
  else if (!failed.length) toast.success(opts.fileId ? "New version added" : ok === 1 ? `${files[0].name} uploaded${into}` : `${ok} files uploaded${into}`, done);
  else toast.error(ok ? `${ok} uploaded, ${failed.length} failed` : failed.length === 1 ? "Upload failed" : `${failed.length} uploads failed`, { ...done, description: failed.join("\n"), duration: 10_000 });
}
