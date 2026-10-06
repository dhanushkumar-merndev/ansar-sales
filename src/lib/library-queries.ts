"use client";

// Library and share reads, run in the browser as the signed-in user (RLS applies).
import { LIBRARY_BUCKET } from "@/lib/library";
import { toPageResult, rangeFor, type PageResult } from "@/lib/pagination";
import { cleanSearch, escapeLike } from "@/lib/search";
import { createClient } from "@/lib/supabase/client";
import type { UsageSummary } from "@/lib/usage";

const sb = () => createClient();

type LibraryItemBase = { id: string; name: string; created_at: string; archived_at: string | null; position: number };
export type LibraryFolder = LibraryItemBase & { kind: "folder"; parent_id: string | null; file_count: number; subfolder_count: number };
export type LibraryFile = LibraryItemBase & {
  kind: "file"; folder_id: string; storage_path: string; thumb_path: string | null; mime_type: string; size_bytes: number;
};
export type LibraryItem = LibraryFolder | LibraryFile;

export type FolderCrumb = { id: string; name: string };

export const LIBRARY_SORTS = {
  custom: { label: "Custom order", p_sort: "custom", p_dir: "asc" },
  "name-asc": { label: "Name A → Z", p_sort: "name", p_dir: "asc" },
  "name-desc": { label: "Name Z → A", p_sort: "name", p_dir: "desc" },
  newest: { label: "Newest first", p_sort: "created", p_dir: "desc" },
  oldest: { label: "Oldest first", p_sort: "created", p_dir: "asc" },
} as const;
export type LibrarySort = keyof typeof LIBRARY_SORTS;

export type ShareableFile = Pick<LibraryFile, "id" | "name" | "mime_type" | "size_bytes" | "thumb_path"> & { folder: { id: string; name: string } };

/** One page of a folder's subfolders and files (top level: folders only), sorted on the server. */
export async function fetchLibraryItems(
  p: { parentId: string | null; q: string; archived: boolean; sort: LibrarySort; foldersFirst: boolean; page: number; pageSize: number },
  signal: AbortSignal,
): Promise<PageResult<LibraryItem>> {
  const { p_sort, p_dir } = LIBRARY_SORTS[p.sort];
  const term = cleanSearch(p.q);
  const { data, error } = await sb()
    .rpc("list_library_items", {
      p_parent_id: p.parentId ?? undefined,
      p_search: term || undefined,
      p_archived: p.archived,
      p_sort,
      p_dir,
      p_folders_first: p.foldersFirst,
      p_limit: p.pageSize,
      p_offset: (p.page - 1) * p.pageSize,
    })
    .abortSignal(signal);
  if (error) throw error;
  const r = data as unknown as { items: LibraryItem[]; total: number };
  return toPageResult(r.items, r.total, p.page, p.pageSize);
}

/** One folder plus its breadcrumb (root → folder). */
export async function fetchLibraryFolder(id: string, signal: AbortSignal) {
  const client = sb();
  const [folder, path] = await Promise.all([
    client.from("library_folders").select("id, name, parent_id, archived_at").eq("id", id).abortSignal(signal).maybeSingle(),
    client.rpc("library_folder_path", { p_folder_id: id }).abortSignal(signal),
  ]);
  if (folder.error) throw folder.error;
  if (path.error) throw path.error;
  return folder.data ? { ...folder.data, path: (path.data ?? []) as unknown as FolderCrumb[] } : null;
}

/** One batched request for a page of files (no per-file round trips). */
export async function signLibraryUrls(paths: string[], expiresInSeconds = 600): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const { data, error } = await sb().storage.from(LIBRARY_BUCKET).createSignedUrls(paths, expiresInSeconds);
  if (error) throw error;
  const urls: Record<string, string> = {};
  for (const d of data ?? []) if (d.path && d.signedUrl) urls[d.path] = d.signedUrl;
  return urls;
}

export async function signLibraryUrl(path: string, opts: { download?: string } = {}) {
  const { data, error } = await sb().storage.from(LIBRARY_BUCKET).createSignedUrl(path, 300, opts.download ? { download: opts.download } : undefined);
  if (error) throw error;
  return data.signedUrl;
}

/** Active files for the share picker: at most 20, optionally within one folder. */
export async function searchShareableFiles(p: { q: string; folderId: string | null }, signal: AbortSignal): Promise<ShareableFile[]> {
  let q = sb()
    .from("library_files")
    .select("id, name, mime_type, size_bytes, thumb_path, folder:library_folders!library_files_folder_id_fkey!inner(id, name)")
    .is("archived_at", null)
    .is("folder.archived_at", null);
  if (p.folderId) q = q.eq("folder_id", p.folderId);
  const term = cleanSearch(p.q).toLowerCase();
  if (term) q = q.ilike("normalized_name", `%${escapeLike(term)}%`);
  const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(20).abortSignal(signal);
  if (error) throw error;
  return data as unknown as ShareableFile[];
}

/** Active folders with full paths ("Brochures / 2026") for pickers (bounded to 300). */
export async function fetchFolderOptions(signal: AbortSignal) {
  const { data, error } = await sb().rpc("library_folder_options").abortSignal(signal);
  if (error) throw error;
  return (data ?? []) as unknown as { id: string; path: string }[];
}

export type ShareSummary = {
  link: { share_id: string; token: string; created_at: string; expires_at: string | null; view_count: number; last_viewed_at: string | null } | null;
  files: { id: string; name: string; mime_type: string; thumb_path: string | null; added_at: string; available: boolean; views: number; downloads: number; last_seen: string | null }[];
  older_links: { share_id: string; created_at: string; expires_at: string | null }[];
};

/** The lead's current document link, its documents with per-document customer activity, and older links. */
export async function fetchLeadShareSummary(leadId: string, signal: AbortSignal): Promise<ShareSummary> {
  const { data, error } = await sb().rpc("lead_share_summary", { p_lead_id: leadId }).abortSignal(signal);
  if (error) throw error;
  return data as unknown as ShareSummary;
}

export type ShareEvent = {
  id: string; type: string; file_name: string | null; device: string | null; meta: Record<string, unknown>; created_at: string;
  actor: { display_name: string } | null;
};

/** Newest-first document timeline; one extra row tells whether more exist. */
export async function fetchShareEvents(leadId: string, limit: number, signal: AbortSignal) {
  const { data, error } = await sb()
    .from("share_events")
    .select("id, type, file_name, device, meta, created_at, actor:profiles!share_events_actor_id_fkey(display_name)")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(0, limit)
    .abortSignal(signal);
  if (error) throw error;
  const items = data as unknown as ShareEvent[];
  return { items: items.slice(0, limit), hasMore: items.length > limit };
}

export async function fetchUsage(signal: AbortSignal): Promise<UsageSummary> {
  const { data, error } = await sb().rpc("admin_usage").abortSignal(signal);
  if (error) throw error;
  return data as unknown as UsageSummary;
}

export type ArchivedFile = Pick<LibraryFile, "id" | "name" | "mime_type" | "size_bytes" | "archived_at" | "thumb_path"> & { folder: { name: string } | null };

/** Archived files, largest first (what frees the most space). */
export async function fetchArchivedFiles(p: { page: number; pageSize: number }, signal: AbortSignal): Promise<PageResult<ArchivedFile>> {
  const [from, to] = rangeFor(p.page, p.pageSize);
  const { data, error, count } = await sb()
    .from("library_files")
    .select("id, name, mime_type, size_bytes, archived_at, thumb_path, folder:library_folders!library_files_folder_id_fkey(name)", { count: "exact" })
    .not("archived_at", "is", null)
    .order("size_bytes", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to)
    .abortSignal(signal);
  if (error) throw error;
  return toPageResult(data as unknown as ArchivedFile[], count ?? 0, p.page, p.pageSize);
}
