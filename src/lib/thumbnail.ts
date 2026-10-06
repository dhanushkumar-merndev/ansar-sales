"use client";

// Small WEBP previews made in the browser: page 1 of a PDF (Mozilla pdf.js) or a
// resized image. Stored next to the file so every view shows a light preview
// instead of downloading the full document.
import { LIBRARY_BUCKET } from "@/lib/library";
import { createClient } from "@/lib/supabase/client";
import { setLibraryThumbnail } from "@/server/actions/library";

const THUMB_WIDTH = 480;

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;

/** pdf.js is loaded only when a preview is needed; its worker runs off the main thread. */
function loadPdfJs() {
  pdfjsPromise ??= import("pdfjs-dist").then((pdfjs) => {
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
    }
    return pdfjs;
  });
  return pdfjsPromise;
}

async function renderPdf(source: Blob) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await source.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport, background: "#ffffff" }).promise;
    return canvas;
  } finally {
    await task.destroy();
  }
}

async function renderImage(source: Blob) {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, THUMB_WIDTH / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** Returns a WEBP preview, or null when one can't be made (corrupt/locked PDF, no WEBP encoder). */
export async function makeThumbnail(source: Blob, mime: string): Promise<Blob | null> {
  try {
    const canvas = mime === "application/pdf" ? await renderPdf(source) : await renderImage(source);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.8));
    // Browsers without a WEBP encoder silently return PNG; the database only accepts WEBP previews.
    return blob && blob.type === "image/webp" ? blob : null;
  } catch {
    return null;
  }
}

/** Makes, uploads and links a preview for a library file. Never throws; false if it couldn't. */
export async function attachThumbnail(file: { id: string; folder_id: string; mime_type: string }, source: Blob) {
  const thumb = await makeThumbnail(source, file.mime_type);
  if (!thumb) return false;
  const path = `${file.folder_id}/thumbs/${crypto.randomUUID()}.webp`;
  const { error } = await createClient().storage.from(LIBRARY_BUCKET).upload(path, thumb, { contentType: "image/webp", upsert: false });
  if (error) return false;
  const r = await setLibraryThumbnail({ fileId: file.id, path });
  return r.ok;
}
