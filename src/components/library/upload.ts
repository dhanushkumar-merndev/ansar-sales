"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isLibraryMime, LIBRARY_MAX_BYTES } from "@/lib/library";
import { attachThumbnail, putObject } from "@/lib/thumbnail";
import type { LibraryFile } from "@/lib/library-queries";
import { registerLibraryFile } from "@/server/actions/library";
import { copyLibraryFile, createLibraryUpload } from "@/server/actions/storage";

/** Uploads files one by one into a folder, with a single progress toast. */
export async function uploadLibraryFiles(folderId: string, picked: File[], folderName?: string) {
  if (!picked.length) return;
  const into = folderName ? ` to ${folderName}` : "";
  const label = (i: number) => (picked.length === 1 ? `Uploading ${picked[0].name}${into}…` : `Uploading ${i + 1} of ${picked.length}${into}…`);
  const toastId = toast.loading(label(0));
  const failed: string[] = [];

  for (const [i, file] of picked.entries()) {
    toast.loading(label(i), { id: toastId });
    if (!isLibraryMime(file.type)) { failed.push(`${file.name}: only PDF, PNG, JPEG or WEBP`); continue; }
    if (file.size > LIBRARY_MAX_BYTES) { failed.push(`${file.name}: larger than 25 MB`); continue; }
    if (file.size === 0) { failed.push(`${file.name}: empty file`); continue; }
    // The server checks the folder and returns a short-lived Tigris URL; the bytes go straight there.
    const target = await createLibraryUpload({ folderId, mime: file.type, size: file.size });
    if (!target.ok) { failed.push(`${file.name}: ${target.error}`); continue; }
    if (!(await putObject(target.data.url, file, file.type))) { failed.push(`${file.name}: upload failed`); continue; }
    const path = target.data.path;
    const r = await registerLibraryFile({ folderId, name: file.name.slice(0, 200), storagePath: path });
    if (!r.ok) { failed.push(`${file.name}: ${r.error}`); continue; }
    await attachThumbnail({ id: r.data.id, mime_type: file.type }, file);
  }

  const ok = picked.length - failed.length;
  if (!failed.length) toast.success(ok === 1 ? `${picked[0].name} uploaded${into}` : `${ok} files uploaded${into}`, { id: toastId });
  else toast.error(ok ? `${ok} uploaded, ${failed.length} failed` : failed.length === 1 ? "Upload failed" : `${failed.length} uploads failed`, { id: toastId, description: failed.join("\n"), duration: 10_000 });
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
