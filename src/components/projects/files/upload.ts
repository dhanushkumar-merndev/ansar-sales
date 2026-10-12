"use client";

import { toast } from "sonner";
import { formatBytes } from "@/lib/projects";
import { PROJECT_FILE_MAX_BYTES, PROJECT_FILE_TYPES, projectFileExt } from "@/lib/storage-paths";
import { registerProjectUpload, signProjectUpload } from "@/server/actions/project-files";

/** Above this a file goes up in parts (several at once, each retried), so big DWG/SketchUp files are safe. */
const MULTIPART_ABOVE = 64 * 1024 ** 2;
const PART = 32 * 1024 ** 2;
const PARALLEL = 3;

export const PROJECT_FILE_ACCEPT = Object.keys(PROJECT_FILE_TYPES).map((e) => `.${e}`).join(",");

class Cancelled extends Error {}

type Sign = { method: "PUT" | "POST" | "DELETE"; key: string; uploadId?: string; partNumber?: number };
async function sign(req: Sign) {
  const r = await signProjectUpload(req);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/** PUT with upload progress (fetch can't report it). Resolves with the ETag. */
function put(url: string, body: Blob, headers: Record<string, string>, signal: AbortSignal, onProgress: (sent: number) => void) {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.getResponseHeader("ETag") ?? "") : reject(new Error(`upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("network error"));
    xhr.onabort = () => reject(new Cancelled());
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal, tries = 3): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Cancelled || signal.aborted || n >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * n));
    }
  }
}

/** Uploads one file straight to Tigris (the server signs each request after checking access, type and quota). Returns its key. */
async function send(folderId: string, file: File, signal: AbortSignal, onProgress: (sent: number) => void) {
  const first = `req:${folderId}:${file.size}:${projectFileExt(file.name)}`;
  if (file.size <= MULTIPART_ABOVE) {
    const s = await sign({ method: "PUT", key: first });
    await withRetry(() => put(s.url, file, s.headers ?? {}, signal, onProgress), signal);
    return s.key!;
  }

  const s = await sign({ method: "POST", key: first });
  const key = s.key!;
  const created = await fetch(s.url, { method: "POST", headers: s.headers, signal });
  const uploadId = (await created.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!created.ok || !uploadId) throw new Error("couldn't start the upload");
  try {
    const count = Math.ceil(file.size / PART);
    const etags: string[] = new Array(count);
    const sent = new Array<number>(count).fill(0);
    let next = 0;
    const worker = async () => {
      while (next < count) {
        const i = next++;
        const chunk = file.slice(i * PART, Math.min(file.size, (i + 1) * PART));
        etags[i] = await withRetry(async () => {
          const p = await sign({ method: "PUT", key, uploadId, partNumber: i + 1 });
          return put(p.url, chunk, {}, signal, (b) => { sent[i] = b; onProgress(sent.reduce((a, x) => a + x, 0)); });
        }, signal);
        if (!etags[i]) throw new Error("the storage didn't confirm a part (ETag missing — check the bucket CORS)");
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, count) }, worker));
    const c = await sign({ method: "POST", key, uploadId });
    const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const done = await fetch(c.url, { method: "POST", body: xml, signal });
    // S3 can answer 200 with an error in the body.
    if (!done.ok || /<Error>/.test(await done.text())) throw new Error("couldn't finish the upload");
    return key;
  } catch (e) {
    const a = await signProjectUpload({ method: "DELETE", key, uploadId });
    if (a.ok) await fetch(a.data.url, { method: "DELETE" }).catch(() => undefined);
    throw e;
  }
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
