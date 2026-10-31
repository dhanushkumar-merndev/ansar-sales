"use client";

// Browser → Tigris uploads, shared by project files and the Library. The server signs every request
// (after checking access, type and size); the bytes never pass through Vercel. Above MULTIPART_ABOVE a
// file goes up in parts, several at once, each retried, so a large video or drawing survives a bad network.

import type { ActionResult } from "@/lib/errors";

export const MULTIPART_ABOVE = 64 * 1024 ** 2;
const PART = 32 * 1024 ** 2;
const PARALLEL = 3;

export class UploadCancelled extends Error {}

export type SignRequest = { method: "PUT" | "POST" | "DELETE"; key: string; uploadId?: string; partNumber?: number };
export type Signed = { url: string; key?: string; headers?: Record<string, string> };
export type Signer = (req: SignRequest) => Promise<ActionResult<Signed>>;

async function signed(sign: Signer, req: SignRequest) {
  const r = await sign(req);
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
    xhr.onabort = () => reject(new UploadCancelled());
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

async function withRetry<T>(fn: () => Promise<T>, signal: AbortSignal, tries = 3): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof UploadCancelled || signal.aborted || n >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * n));
    }
  }
}

/**
 * Uploads one file. `first` is the opening request's key ("req:…"), from which the server picks the
 * real object name; that name is returned.
 */
export async function uploadObject({ file, first, sign, signal, onProgress }: {
  file: File; first: string; sign: Signer; signal: AbortSignal; onProgress: (sent: number) => void;
}) {
  if (file.size <= MULTIPART_ABOVE) {
    const s = await signed(sign, { method: "PUT", key: first });
    await withRetry(() => put(s.url, file, s.headers ?? {}, signal, onProgress), signal);
    return s.key!;
  }

  const s = await signed(sign, { method: "POST", key: first });
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
          const p = await signed(sign, { method: "PUT", key, uploadId, partNumber: i + 1 });
          return put(p.url, chunk, {}, signal, (b) => { sent[i] = b; onProgress(sent.reduce((a, x) => a + x, 0)); });
        }, signal);
        if (!etags[i]) throw new Error("the storage didn't confirm a part (ETag missing — check the bucket CORS)");
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, count) }, worker));
    const c = await signed(sign, { method: "POST", key, uploadId });
    const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const done = await fetch(c.url, { method: "POST", body: xml, signal });
    // S3 can answer 200 with an error in the body.
    if (!done.ok || /<Error>/.test(await done.text())) throw new Error("couldn't finish the upload");
    return key;
  } catch (e) {
    const a = await sign({ method: "DELETE", key, uploadId });
    if (a.ok) await fetch(a.data.url, { method: "DELETE" }).catch(() => undefined);
    throw e;
  }
}
