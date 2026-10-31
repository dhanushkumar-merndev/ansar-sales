// Shared by the browser upload flow, server actions and the public share page.
import { LIBRARY_FILE_RE } from "@/lib/storage-paths";

export const LIBRARY_MIME_TYPES = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
} as const;
export type LibraryMimeType = keyof typeof LIBRARY_MIME_TYPES;

export const LIBRARY_ACCEPT = Object.keys(LIBRARY_MIME_TYPES).join(",");
/** PDFs and images. */
export const LIBRARY_MAX_BYTES = 25 * 1024 * 1024;
/** Videos stream straight from storage, so they can be much larger (the database enforces the same limits). */
export const LIBRARY_VIDEO_MAX_BYTES = 500 * 1024 * 1024;
export const SHARE_MAX_FILES = 10;

export const SHARE_EXPIRY = { "24h": "24 hours", "7d": "7 days", "30d": "30 days", never: "Never expires" } as const;
export type ShareExpiry = keyof typeof SHARE_EXPIRY;

export const CALL_OUTCOMES = { connected: "Connected", no_answer: "No answer", busy: "Busy", wrong_number: "Wrong number" } as const;
export type CallOutcome = keyof typeof CALL_OUTCOMES;

export const isLibraryMime = (t: string): t is LibraryMimeType => t in LIBRARY_MIME_TYPES;
export const isImageMime = (t: string) => t.startsWith("image/");
export const isVideoMime = (t: string) => t.startsWith("video/");
export const libraryMaxBytes = (mime: string) => (isVideoMime(mime) ? LIBRARY_VIDEO_MAX_BYTES : LIBRARY_MAX_BYTES);
/** "25 MB" / "500 MB", for messages. */
export const libraryLimitLabel = (mime: string) => `${libraryMaxBytes(mime) / (1024 * 1024)} MB`;

/** Storage object path: "<folderId>/<uuid>.<ext>" (validated again by the database). */
export const STORAGE_PATH_RE = LIBRARY_FILE_RE;

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Public URL of a share link (browser: falls back to the current origin). */
export function shareUrl(token: string) {
  const base = (process.env.NEXT_PUBLIC_APP_URL || (typeof window !== "undefined" ? window.location.origin : "")).replace(/\/+$/, "");
  return `${base}/s/${token}`;
}

/** wa.me wants the international number as digits only. */
export function whatsappUrl(e164: string, text?: string) {
  const base = `https://wa.me/${e164.replace(/\D/g, "")}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}
