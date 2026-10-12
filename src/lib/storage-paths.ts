// Object names and their validation, shared by server actions, routes and tests.
// Database paths are bucket-relative ("<folder>/<file>.pdf"); Tigris keys add the bucket prefix.

export type StorageBucket = "library" | "logos" | "projects";

export const storageKey = (bucket: StorageBucket, name: string) => `${bucket}/${name}`;

/** A library file: "<folderId>/<uuid>.<ext>" (the database checks the folder part again). */
export const LIBRARY_FILE_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|webp)$/;
/** A library preview: "<folderId>/thumbs/<uuid>.webp". */
export const LIBRARY_THUMB_RE = /^[0-9a-f-]{36}\/thumbs\/[0-9a-f-]{36}\.webp$/;
/** A company logo: "<companyId>/<uuid>.<ext>". */
export const LOGO_PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/;

export const isLibraryObjectPath = (p: string) => LIBRARY_FILE_RE.test(p) || LIBRARY_THUMB_RE.test(p);

export const LOGO_MIME_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;
export type LogoMimeType = keyof typeof LOGO_MIME_TYPES;
export const isLogoMime = (t: string): t is LogoMimeType => t in LOGO_MIME_TYPES;
export const LOGO_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Project files: "<projectId>/<uuid>.<ext>", up to 5 GB each, by extension.
// ---------------------------------------------------------------------------
export const PROJECT_FILE_RE = /^([0-9a-f-]{36})\/[0-9a-f-]{36}\.([a-z0-9]{2,5})$/;
export const PROJECT_FILE_MAX_BYTES = 5 * 1024 ** 3;
/** Allowed extensions and the content type we store them with (the upload is signed for it). */
export const PROJECT_FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic",
  dwg: "image/vnd.dwg", dxf: "image/vnd.dxf", skp: "application/vnd.sketchup.skp",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", csv: "text/csv", zip: "application/zip",
};
export const projectFileExt = (name: string) => (name.match(/\.([A-Za-z0-9]{2,5})$/)?.[1] ?? "").toLowerCase();
