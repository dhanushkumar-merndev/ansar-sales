"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatBytes, isLibraryMime, isVideoMime, LIBRARY_MIME_TYPES, libraryLimitLabel, libraryMaxBytes } from "@/lib/library";
import { MULTIPART_ABOVE, UploadCancelled, uploadObject } from "@/lib/multipart-upload";
import { attachThumbnail, checkVideo } from "@/lib/thumbnail";
import type { LibraryFile } from "@/lib/library-queries";
import { registerLibraryFile } from "@/server/actions/library";
import { copyLibraryFile, signLibraryUpload } from "@/server/actions/storage";

/** Uploads files one by one into a folder, with a single progress toast (percent and MB for big files). */
export async function uploadLibraryFiles(folderId: string, picked: File[], folderName?: string) {
  if (!picked.length) return;
  const into = folderName ? ` to ${folderName}` : "";
  const ctrl = new AbortController();
  const total = picked.reduce((s, f) => s + f.size, 0);
  let doneBytes = 0;
  const cancel = { label: "Cancel", onClick: () => ctrl.abort() };
  const label = (i: number, sent: number) => {
    const what = picked.length === 1 ? picked[0].name : `${i + 1} of ${picked.length}`;
    if (total <= MULTIPART_ABOVE) return `Uploading ${what}${into}…`;
    const pct = Math.floor(((doneBytes + sent) / total) * 100);
    return `Uploading ${what}${into}… ${pct}% (${formatBytes(doneBytes + sent)} of ${formatBytes(total)})`;
  };
  const toastId = toast.loading(label(0, 0), { action: cancel, duration: Infinity });
  const warn = (e: BeforeUnloadEvent) => e.preventDefault();
  window.addEventListener("beforeunload", warn);
  const failed: string[] = [];
  const cautions: string[] = [];
  let ok = 0;
  let last = 0;

  try {
    for (const [i, file] of picked.entries()) {
      if (ctrl.signal.aborted) break;
      toast.loading(label(i, 0), { id: toastId, action: cancel, duration: Infinity });
      if (!isLibraryMime(file.type)) { failed.push(`${file.name}: only PDF, PNG, JPEG, WEBP or MP4/WEBM/MOV video`); doneBytes += file.size; continue; }
      if (file.size > libraryMaxBytes(file.type)) { failed.push(`${file.name}: larger than ${libraryLimitLabel(file.type)}`); doneBytes += file.size; continue; }
      if (file.size === 0) { failed.push(`${file.name}: empty file`); continue; }
      if (isVideoMime(file.type)) {
        const check = await checkVideo(file);
        if (check === "hevc") cautions.push(`${file.name}: recorded in HEVC (iPhone "High Efficiency"), which some Android phones can't play`);
        else if (check === "unplayable") cautions.push(`${file.name}: this browser can't play it, so many phones may not either`);
      }
      try {
        // The server checks the folder, type and size and signs each request; the bytes go straight to Tigris.
        const path = await uploadObject({
          file,
          first: `req:${folderId}:${file.size}:${LIBRARY_MIME_TYPES[file.type]}`,
          sign: signLibraryUpload,
          signal: ctrl.signal,
          onProgress: (sent) => {
            const now = Date.now();
            if (now - last < 200) return;
            last = now;
            toast.loading(label(i, sent), { id: toastId, action: cancel, duration: Infinity });
          },
        });
        doneBytes += file.size;
        const r = await registerLibraryFile({ folderId, name: file.name.slice(0, 200), storagePath: path });
        if (!r.ok) { failed.push(`${file.name}: ${r.error}`); continue; }
        ok++;
        await attachThumbnail({ id: r.data.id, mime_type: file.type }, file);
      } catch (e) {
        if (e instanceof UploadCancelled || ctrl.signal.aborted) break;
        failed.push(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
        doneBytes += file.size;
      }
    }
  } finally {
    window.removeEventListener("beforeunload", warn);
  }

  const description = [...failed, ...cautions.map((c) => `Heads up: ${c}. On iPhone, set Camera → Formats → Most Compatible, or send it through WhatsApp once and upload that copy.`)].join("\n") || undefined;
  if (ctrl.signal.aborted) toast.info(ok ? `Upload cancelled · ${ok} uploaded` : "Upload cancelled", { id: toastId, action: undefined, duration: 4000 });
  else if (!failed.length) toast.success(ok === 1 ? `${picked[0].name} uploaded${into}` : `${ok} files uploaded${into}`, { id: toastId, action: undefined, description, duration: cautions.length ? 15_000 : 4000 });
  else toast.error(ok ? `${ok} uploaded, ${failed.length} failed` : failed.length === 1 ? "Upload failed" : `${failed.length} uploads failed`, { id: toastId, action: undefined, description, duration: 15_000 });
}

/** Copies files into a folder: the server copies each object in Tigris and registers the copy. */
export async function copyLibraryFiles(files: Pick<LibraryFile, "id" | "name">[], folderId: string, folderName: string) {
  if (!files.length) return 0;
  const label = (i: number) => (files.length === 1 ? `Copying ${files[0].name} to ${folderName}…` : `Copying ${i + 1} of ${files.length} to ${folderName}…`);
  const toastId = toast.loading(label(0));
  const failed: string[] = [];

  for (const [i, file] of files.entries()) {
    toast.loading(label(i), { id: toastId });
    const r = await copyLibraryFile({ fileId: file.id, folderId });
    if (!r.ok) failed.push(`${file.name}: ${r.error}`);
  }

  const ok = files.length - failed.length;
  if (!failed.length) toast.success(ok === 1 ? `${files[0].name} copied to ${folderName}` : `${ok} files copied to ${folderName}`, { id: toastId });
  else toast.error(ok ? `${ok} copied, ${failed.length} failed` : "Copy failed", { id: toastId, description: failed.join("\n"), duration: 10_000 });
  return ok;
}

const hasFiles = (e: React.DragEvent | DragEvent) => !!e.dataTransfer?.types.includes("Files");

/**
 * Makes an element a drop target for files from the computer. Spread `props`
 * on it. Zones can nest: only the innermost zone under the pointer lights up
 * and receives the drop. Drops that miss every zone are swallowed so the
 * browser doesn't navigate away to open the file.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      if (e.type === "dragover" && e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
      window.clearTimeout(timer.current);
    };
  }, []);

  const isInnermost = (e: React.DragEvent) => (e.target as Element).closest?.("[data-file-drop]") === e.currentTarget;
  const clear = () => { window.clearTimeout(timer.current); setOver(false); };

  return {
    over: enabled && over,
    props: {
      "data-file-drop": "",
      onDragOver: (e: React.DragEvent) => {
        if (!enabled || !hasFiles(e)) return;
        if (!isInnermost(e)) { clear(); return; }
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
        // Safety net in case no dragleave arrives (e.g. the drag is cancelled outside the window).
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setOver(false), 1000);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) clear();
      },
      onDrop: (e: React.DragEvent) => {
        if (!enabled || !hasFiles(e) || !isInnermost(e)) return;
        e.preventDefault();
        clear();
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
      },
    },
  };
}
