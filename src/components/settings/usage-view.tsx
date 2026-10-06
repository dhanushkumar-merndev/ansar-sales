"use client";

import { useState } from "react";
import { Database, ExternalLink, FileText, HardDrive, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataPagination } from "@/components/common/data-pagination";
import { ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { Bars } from "@/components/dashboard/widgets";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLiveQuery } from "@/hooks/use-live-query";
import { DEFAULT_PAGE_SIZE } from "@/lib/constants";
import { formatCount } from "@/lib/format";
import { formatBytes } from "@/lib/library";
import { fetchArchivedFiles, fetchUsage, signLibraryUrls } from "@/lib/library-queries";
import { lastPage } from "@/lib/pagination";
import { formatDate } from "@/lib/time";
import { FREE_PLAN_LIMITS, USAGE_WARN_PERCENT, usagePercent } from "@/lib/usage";
import { cn } from "@/lib/utils";
import { cleanUnregisteredUploads, deleteArchivedFile } from "@/server/actions/usage";

const LIBRARY_TABLES = ["library_files", "library_folders"];

export function UsageView() {
  const usage = useLiveQuery({ queryKey: "admin-usage", fetcher: fetchUsage, tables: LIBRARY_TABLES });
  const u = usage.data;

  if (usage.error && !u) return <ErrorState message={usage.error} onRetry={usage.refetch} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Compared with the Supabase Free plan: 1 GB file storage and 500 MB database.</p>
        <FetchingIndicator show={usage.isFetching && !usage.isInitialLoading} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Meter
          icon={<HardDrive className="size-4" />}
          title="File storage"
          used={u ? Number(u.storage_bytes) : null}
          limit={FREE_PLAN_LIMITS.storageBytes}
          hint={u ? `${formatCount(Number(u.storage_objects))} files in Supabase Storage` : ""}
          warning="Almost full. Delete archived files below to free space."
        />
        <Meter
          icon={<Database className="size-4" />}
          title="Database"
          used={u ? Number(u.database_bytes) : null}
          limit={FREE_PLAN_LIMITS.databaseBytes}
          hint="Leads, notes, follow-ups, finance and history"
          warning="Almost full. Consider upgrading the Supabase plan."
        />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Library</CardTitle>
            <CardDescription>What the file storage is used for.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {!u ? <ListSkeleton rows={3} /> : (
              <>
                <dl className="divide-y rounded-md border">
                  <UsageRow label="Active files" files={u.library.active_files} bytes={u.library.active_bytes} />
                  <UsageRow label="Archived (still using space)" files={u.library.archived_files} bytes={u.library.archived_bytes} tone={u.library.archived_files ? "warn" : undefined} />
                  <UsageRow label="Leftover uploads" files={u.library.unregistered_files} bytes={u.library.unregistered_bytes} tone={u.library.unregistered_files ? "warn" : undefined} />
                </dl>
                <p className="text-muted-foreground">
                  PDFs {formatBytes(Number(u.by_type.pdf_bytes))} · Images {formatBytes(Number(u.by_type.image_bytes))} ·{" "}
                  {formatCount(Number(u.shares.active_links))} active share {Number(u.shares.active_links) === 1 ? "link" : "links"}, opened {formatCount(Number(u.shares.total_opens))}×
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Storage by folder</CardTitle>
            <CardDescription>Active files only · largest 8 folders</CardDescription>
          </CardHeader>
          <CardContent>
            {!u ? <Skeleton className="h-40 w-full" /> : !u.by_folder.length ? (
              <p className="text-sm text-muted-foreground">No files in the Library yet.</p>
            ) : (
              <Bars horizontal label="Storage" format={formatBytes} items={u.by_folder.map((f) => ({ name: f.name, value: Number(f.bytes) }))} />
            )}
          </CardContent>
        </Card>
      </div>

      <FreeUpSpace leftover={u ? { files: Number(u.library.unregistered_files), bytes: Number(u.library.unregistered_bytes) } : null} onChanged={usage.refetch} />

      <p className="text-xs text-muted-foreground">
        Bandwidth (egress), Realtime and Edge Function usage are only shown in the{" "}
        <a href="https://supabase.com/dashboard/project/_/usage" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground">
          Supabase dashboard <ExternalLink className="size-3" />
        </a>.
      </p>
    </div>
  );
}

function Meter({ icon, title, used, limit, hint, warning }: { icon: React.ReactNode; title: string; used: number | null; limit: number; hint: string; warning: string }) {
  const pct = used === null ? 0 : usagePercent(used, limit);
  const high = pct >= USAGE_WARN_PERCENT;
  return (
    <Card className={cn(high && "border-red-200")}>
      <CardHeader>
        <CardDescription className="flex items-center gap-2">{icon}{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">
          {used === null ? <span className="inline-block h-7 w-40 animate-pulse rounded bg-muted" /> : (
            <>{formatBytes(used)} <span className="text-base font-normal text-muted-foreground">of {formatBytes(limit)}</span></>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${title} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className={cn("h-full rounded-full", high ? "bg-red-500" : "bg-primary")} style={{ width: `${Math.max(pct, used ? 1 : 0)}%` }} />
        </div>
        <p className={cn("text-xs", high ? "text-red-700" : "text-muted-foreground")}>
          {used === null ? " " : `${pct}% used · ${high ? warning : hint}`}
        </p>
      </CardContent>
    </Card>
  );
}

function UsageRow({ label, files, bytes, tone }: { label: string; files: number; bytes: number; tone?: "warn" }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <dt className={cn(tone === "warn" ? "text-foreground" : "text-muted-foreground")}>{label}</dt>
      <dd className="text-right tabular-nums">
        <span className="font-medium">{formatBytes(Number(bytes))}</span>{" "}
        <span className="text-xs text-muted-foreground">· {formatCount(Number(files))} {Number(files) === 1 ? "file" : "files"}</span>
      </dd>
    </div>
  );
}

function FreeUpSpace({ leftover, onChanged }: { leftover: { files: number; bytes: number } | null; onChanged: () => void }) {
  const [paging, setPaging] = useState({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  const { data, error, isFetching, isInitialLoading, isStale, refetch } = useLiveQuery({
    queryKey: `archived-files:${paging.page}:${paging.pageSize}`,
    fetcher: (s) => fetchArchivedFiles(paging, s),
    tables: LIBRARY_TABLES,
  });
  // Deleting the last row of a page: move to the last valid page (adjusted during render).
  if (data && !isStale && data.items.length === 0 && data.total > 0 && paging.page > 1) {
    const page = lastPage(data.total, paging.pageSize);
    if (page !== paging.page) setPaging({ ...paging, page });
  }
  const done = () => { refetch(); onChanged(); };
  const thumbPaths = (data?.items ?? []).map((f) => f.thumb_path).filter((p): p is string => !!p);
  const thumbs = useLiveQuery({ queryKey: `archived-thumbs:${thumbPaths.join("|")}`, fetcher: () => signLibraryUrls(thumbPaths), enabled: thumbPaths.length > 0, pollMs: 300_000 });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Free up space</CardTitle>
          <CardDescription>Archived files still use storage until they are deleted permanently. Largest first.</CardDescription>
        </div>
        {leftover && leftover.files > 0 ? (
          <ConfirmDialog
            trigger={<Button size="sm" variant="outline"><Trash2 /> Clean up {formatCount(leftover.files)} leftover {leftover.files === 1 ? "upload" : "uploads"}</Button>}
            title="Delete leftover uploads?"
            description={`These ${formatBytes(leftover.bytes)} are uploads that never finished being added to the Library (for example, the page was closed mid-upload). Uploads from the last hour are kept.`}
            confirmLabel="Delete"
            destructive
            onConfirm={async () => {
              const r = await cleanUnregisteredUploads({});
              if (!r.ok) { toast.error(r.error); return false; }
              toast.success(r.data.files ? `Freed ${formatBytes(r.data.freedBytes)}` : "Nothing to clean up yet");
              done();
            }}
          />
        ) : null}
      </CardHeader>
      <CardContent>
        {error && !data ? <ErrorState message={error} onRetry={refetch} /> : isInitialLoading ? <ListSkeleton rows={3} /> : !data?.total ? (
          <p className="text-sm text-muted-foreground">No archived files. Archive files in the Library first, then delete them here to free space.</p>
        ) : (
          <div className={cn(isStale && "opacity-60")}>
            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow><TableHead>File</TableHead><TableHead className="hidden sm:table-cell">Archived</TableHead><TableHead className="text-right">Size</TableHead><TableHead className="w-10" /></TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell className="max-w-[18rem]">
                        <div className="flex items-center gap-2.5">
                        {f.thumb_path && thumbs.data?.[f.thumb_path] ? (
                          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
                          <img src={thumbs.data[f.thumb_path]} alt="" className="size-9 shrink-0 rounded border object-cover object-top" />
                        ) : (
                          <span className="flex size-9 shrink-0 items-center justify-center rounded border bg-muted/40"><FileText className="size-4 text-muted-foreground" /></span>
                        )}
                        <div className="min-w-0">
                        <p className="truncate font-medium" title={f.name}>{f.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{f.folder?.name ?? "—"}</p>
                        </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap sm:table-cell">{f.archived_at ? formatDate(f.archived_at) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBytes(Number(f.size_bytes))}</TableCell>
                      <TableCell>
                        <ConfirmDialog
                          trigger={<Button variant="ghost" size="icon-sm" aria-label={`Delete ${f.name} permanently`}><Trash2 /></Button>}
                          title={`Delete "${f.name}" permanently?`}
                          description={`Frees ${formatBytes(Number(f.size_bytes))}. Customers' share links will no longer show this file. This can't be undone.`}
                          confirmLabel="Delete permanently"
                          destructive
                          onConfirm={async () => {
                            const r = await deleteArchivedFile({ id: f.id });
                            if (!r.ok) { toast.error(r.error); return false; }
                            toast.success(`Deleted · freed ${formatBytes(r.data.freedBytes)}`);
                            done();
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <DataPagination inline page={paging.page} pageSize={paging.pageSize} total={data.total} disabled={isFetching}
              onPageChange={(page) => setPaging({ ...paging, page })} onPageSizeChange={(pageSize) => setPaging({ page: 1, pageSize })} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
