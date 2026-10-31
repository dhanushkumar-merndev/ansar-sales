"use client";

// Small WEBP previews made in the browser: page 1 of a PDF (Mozilla pdf.js), a
// resized image, or a frame of a video (its poster). Stored next to the file so every view shows a light preview
// instead of downloading the full document.
import { setLibraryThumbnail } from "@/server/actions/library";
import { createThumbnailUpload } from "@/server/actions/storage";

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

/** Loads a video file in a hidden element until its first frame is decoded (throws if this browser can't). */
function loadVideo(source: Blob) {
  const url = URL.createObjectURL(source);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const done = () => { URL.revokeObjectURL(url); video.removeAttribute("src"); video.load(); };
  const ready = new Promise<HTMLVideoElement>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 20_000);
    video.onloadeddata = () => { clearTimeout(timer); if (video.videoWidth > 0) resolve(video); else reject(new Error("no picture")); };
    video.onerror = () => { clearTimeout(timer); reject(new Error("can't play")); };
  });
  video.src = url;
  return { ready, done };
}

async function renderVideo(source: Blob) {
  const { ready, done } = loadVideo(source);
  try {
    const video = await ready;
    // A frame a moment in (the very first one is often black).
    const at = Number.isFinite(video.duration) ? Math.min(1, video.duration / 2) : 0;
    if (at > 0) {
      await new Promise<void>((resolve) => { video.onseeked = () => resolve(); video.currentTime = at; setTimeout(resolve, 5000); });
    }
    const scale = Math.min(1, THUMB_WIDTH / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    done();
  }
}

/**
 * Whether a video will play for most customers: this browser must decode it, and it must not be HEVC
 * (iPhone's "High Efficiency" format), which many Android phones and Firefox can't play. The codec is
 * read from the file's index ("hvc1"/"hev1"), found in its first or last few MB.
 */
export async function checkVideo(source: Blob): Promise<"ok" | "hevc" | "unplayable"> {
  const MB2 = 2 * 1024 * 1024;
  const text = async (b: Blob) => new TextDecoder("latin1").decode(await b.arrayBuffer());
  try {
    const head = await text(source.slice(0, MB2));
    const tail = source.size > MB2 ? await text(source.slice(Math.max(MB2, source.size - MB2))) : "";
    if (/hvc1|hev1/.test(head) || /hvc1|hev1/.test(tail)) return "hevc";
  } catch {
    // Unreadable here: fall through to the playback check.
  }
  const { ready, done } = loadVideo(source);
  try {
    await ready;
    return "ok";
  } catch {
    return "unplayable";
  } finally {
    done();
  }
}

/** Returns a WEBP preview, or null when one can't be made (corrupt/locked PDF, unplayable video, no WEBP encoder). */
export async function makeThumbnail(source: Blob, mime: string): Promise<Blob | null> {
  try {
    const canvas = mime === "application/pdf" ? await renderPdf(source) : mime.startsWith("video/") ? await renderVideo(source) : await renderImage(source);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.8));
    // Browsers without a WEBP encoder silently return PNG; the database only accepts WEBP previews.
    return blob && blob.type === "image/webp" ? blob : null;
  } catch {
    return null;
  }
}

/** PUTs a body to a presigned Tigris upload URL (type and length must match what was signed). */
export async function putObject(url: string, body: Blob, contentType: string) {
  try {
    const res = await fetch(url, { method: "PUT", body, headers: { "Content-Type": contentType } });
    return res.ok;
  } catch {
    return false;
  }
}

/** Makes, uploads and links a preview for a library file. Never throws; false if it couldn't. */
export async function attachThumbnail(file: { id: string; mime_type: string }, source: Blob) {
  const thumb = await makeThumbnail(source, file.mime_type);
  if (!thumb) return false;
  try {
    const target = await createThumbnailUpload({ fileId: file.id, size: thumb.size });
    if (!target.ok || !(await putObject(target.data.url, thumb, "image/webp"))) return false;
    const r = await setLibraryThumbnail({ fileId: file.id, path: target.data.path });
    return r.ok;
  } catch {
    return false;
  }
}
