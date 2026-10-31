"use client";

import { useState } from "react";
import { FileText, Film, ImageIcon, Search, X } from "lucide-react";
import { toast } from "sonner";
import { ErrorState } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { formatBytes, isImageMime, isVideoMime, SHARE_MAX_FILES } from "@/lib/library";
import { fetchFolderOptions, searchShareableFiles, signLibraryUrls, type ShareableFile } from "@/lib/library-queries";
import { cleanSearch } from "@/lib/search";
import { cn } from "@/lib/utils";

export const fileIcon = (mime: string) => (isImageMime(mime) ? ImageIcon : isVideoMime(mime) ? Film : FileText);

/**
 * Picks up to SHARE_MAX_FILES library files: a folder filter, a search (300 ms debounce, 20 results),
 * the list with small previews, and the picked files as removable chips (in the order picked).
 * `included`: files already in the lead's link, shown ticked and locked.
 */
export function LibraryFilePicker({ enabled, selected, onChange, included }: {
  enabled: boolean; selected: Map<string, ShareableFile>; onChange: (next: Map<string, ShareableFile>) => void; included?: Set<string>;
}) {
  const [folderId, setFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const q = useDebouncedValue(cleanSearch(search), SEARCH_DEBOUNCE_MS);
  const folders = useLiveQuery({ queryKey: "share-folders", fetcher: fetchFolderOptions, tables: ["library_folders"], enabled });
  const files = useLiveQuery({
    queryKey: `share-files:${folderId}:${q}`,
    fetcher: (s) => searchShareableFiles({ q, folderId }, s),
    tables: ["library_files", "library_folders"],
    enabled,
  });
  // Small previews for the listed files: one batched signing request.
  const thumbPaths = (files.data ?? []).map((f) => f.thumb_path).filter((p): p is string => !!p);
  const thumbs = useLiveQuery({
    queryKey: `share-thumbs:${thumbPaths.join("|")}`,
    fetcher: () => signLibraryUrls(thumbPaths),
    enabled: enabled && thumbPaths.length > 0,
    pollMs: 300_000,
  });

  const toggle = (f: ShareableFile) => {
    const next = new Map(selected);
    if (next.has(f.id)) next.delete(f.id);
    else if (next.size < SHARE_MAX_FILES) next.set(f.id, f);
    else return void toast.error(`You can pick up to ${SHARE_MAX_FILES} files.`);
    onChange(next);
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={folderId ?? "__all"} onValueChange={(v) => setFolderId(v === "__all" ? null : v)}>
          <SelectTrigger className="w-full sm:w-44" aria-label="Folder"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All folders</SelectItem>
            {(folders.data ?? []).map((f) => <SelectItem key={f.id} value={f.id}>{f.path}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search files" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search files" />
        </div>
      </div>

      <div className="max-h-56 overflow-y-auto rounded-md border" aria-busy={files.isFetching}>
        {files.error && !files.data ? (
          <div className="p-2"><ErrorState message={files.error} onRetry={files.refetch} /></div>
        ) : files.isInitialLoading ? (
          <div className="space-y-1 p-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : !files.data?.length ? (
          <p className="p-4 text-center text-sm text-muted-foreground">{q || folderId ? "No files match." : "The library is empty. Upload files from Library first."}</p>
        ) : (
          <ul className={cn("divide-y", files.isStale && "opacity-60")}>
            {files.data.map((f) => {
              const inLink = !!included?.has(f.id);
              const checked = inLink || selected.has(f.id);
              const Icon = fileIcon(f.mime_type);
              const thumb = f.thumb_path ? thumbs.data?.[f.thumb_path] : undefined;
              return (
                <li key={f.id}>
                  <label className={cn("flex items-center gap-3 px-3 py-2", inLink ? "opacity-60" : "cursor-pointer hover:bg-white/[0.04]")}>
                    <Checkbox checked={checked} disabled={inLink} onCheckedChange={() => toggle(f)} aria-label={inLink ? `${f.name} is already in the link` : undefined} />
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Tigris URL
                      <img src={thumb} alt="" className="size-10 shrink-0 rounded border object-cover object-top" />
                    ) : (
                      <span className="flex size-10 shrink-0 items-center justify-center rounded border bg-muted/40"><Icon className="size-4 text-muted-foreground" /></span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{f.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{inLink ? "Already in the link · " : ""}{f.folder.name} · {formatBytes(f.size_bytes)}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selected.size ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Picked files">
          {[...selected.values()].map((f) => (
            <Badge key={f.id} variant="outline" className="max-w-full gap-1 pr-1">
              <span className="truncate">{f.name}</span>
              <button type="button" className="rounded-full p-0.5 hover:bg-white/10" onClick={() => toggle(f)} aria-label={`Remove ${f.name}`}><X className="size-3" /></button>
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
