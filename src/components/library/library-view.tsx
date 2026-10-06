"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, Folder, FolderPlus, Loader2, MoreHorizontal, Pencil, Search } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataPagination } from "@/components/common/data-pagination";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { formatCount } from "@/lib/format";
import { fetchLibraryFolders, type LibraryFolder } from "@/lib/library-queries";
import { lastPage, parsePaging } from "@/lib/pagination";
import { can } from "@/lib/permissions";
import { cleanSearch } from "@/lib/search";
import { cn } from "@/lib/utils";
import { createFolder, renameFolder, setFolderArchived } from "@/server/actions/library";

/** Search box bound to the `q` URL param (300 ms debounce). */
export function useUrlSearch() {
  const { params, set } = useUrlState();
  const q = cleanSearch(params.get("q"));
  const [input, setInput] = useState(q);
  const debounced = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debounced !== q) set({ q: debounced }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  return { q, input, setInput };
}

export function LibraryView() {
  const profile = useProfile();
  const isAdmin = can.manageLibrary(profile.role);
  const { params, set } = useUrlState();
  const paging = parsePaging(params);
  const { q, input, setInput } = useUrlSearch();
  const archived = isAdmin && params.get("archived") === "1";
  const query = useMemo(() => ({ parentId: null, q, archived, page: paging.page, pageSize: paging.pageSize }), [q, archived, paging.page, paging.pageSize]);

  const { data, error, isFetching, isInitialLoading, isStale, refetch } = useLiveQuery({
    queryKey: `library-folders:${profile.id}:${JSON.stringify(query)}`,
    fetcher: (s) => fetchLibraryFolders(query, s),
    tables: ["library_folders", "library_files"],
  });
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
  }, [data, isStale, query.page, query.pageSize, set]);

  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader
        title="Library"
        description="Brochures, price lists and photos to share with customers. PDF, PNG, JPEG or WEBP, up to 25 MB each."
        actions={<Button onClick={() => setCreating(true)}><FolderPlus /> New folder</Button>}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search folders" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Search folders" />
        </div>
        {isAdmin ? (
          <Label className="flex items-center gap-2 font-normal"><Checkbox checked={archived} onCheckedChange={(c) => set({ archived: c === true ? "1" : null })} /> Archived</Label>
        ) : null}
        <FetchingIndicator show={isFetching && !isInitialLoading} />
      </div>
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : isInitialLoading ? <ListSkeleton /> : !data?.total ? (
        <EmptyState
          title={archived ? "No archived folders" : q ? "No folders match" : "No folders yet"}
          description={archived || q ? undefined : "Create a folder, then upload files or add subfolders inside it."}
          action={!archived && !q ? <Button onClick={() => setCreating(true)}><FolderPlus /> New folder</Button> : undefined}
        />
      ) : (
        <div className={cn(isStale && "opacity-60")}>
          <FolderCards folders={data.items} isAdmin={isAdmin} onChanged={refetch} />
          <DataPagination page={query.page} pageSize={query.pageSize} total={data.total} disabled={isFetching}
            onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s) })} />
        </div>
      )}
      <FolderNameDialog open={creating} parentId={null} onOpenChange={setCreating} onDone={refetch} />
    </>
  );
}

/** Grid of folder cards (top level or subfolders), with admin rename/archive. */
export function FolderCards({ folders, isAdmin, onChanged }: { folders: LibraryFolder[]; isAdmin: boolean; onChanged: () => void }) {
  const [renaming, setRenaming] = useState<LibraryFolder | null>(null);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {folders.map((f) => {
          const files = f.files[0]?.count ?? 0;
          const subfolders = f.subfolders[0]?.count ?? 0;
          return (
            <Card key={f.id} className="relative flex-row items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]">
              <Folder className="size-8 shrink-0 text-muted-foreground" aria-hidden />
              <Link href={`/library/${f.id}`} className="min-w-0 flex-1 after:absolute after:inset-0">
                <p className="truncate font-medium">{f.name}</p>
                <p className="text-xs text-muted-foreground">
                  {subfolders ? `${formatCount(subfolders)} ${subfolders === 1 ? "folder" : "folders"} · ` : ""}
                  {formatCount(files)} {files === 1 ? "file" : "files"}
                </p>
              </Link>
              {isAdmin ? <FolderMenu folder={f} onRename={() => setRenaming(f)} onDone={onChanged} /> : null}
            </Card>
          );
        })}
      </div>
      <FolderNameDialog open={!!renaming} folder={renaming} parentId={renaming?.parent_id ?? null} onOpenChange={(o) => !o && setRenaming(null)} onDone={onChanged} />
    </>
  );
}

function FolderMenu({ folder, onRename, onDone }: { folder: LibraryFolder; onRename: () => void; onDone: () => void }) {
  const archived = !!folder.archived_at;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" className="relative z-[1]" aria-label={`Actions for ${folder.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!archived ? <DropdownMenuItem onSelect={onRename}><Pencil /> Rename</DropdownMenuItem> : null}
        <ConfirmDialog
          trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}>{archived ? <><ArchiveRestore /> Restore</> : <><Archive /> Archive</>}</DropdownMenuItem>}
          title={archived ? `Restore "${folder.name}"?` : `Archive "${folder.name}"?`}
          description={archived ? "Its files can be shared again." : "Its files are hidden and stop opening from existing share links. Archive its subfolders first. You can restore it later."}
          confirmLabel={archived ? "Restore" : "Archive"}
          destructive={!archived}
          onConfirm={async () => {
            const r = await setFolderArchived({ id: folder.id, archived: !archived });
            if (!r.ok) { toast.error(r.error); return false; }
            toast.success(archived ? `"${folder.name}" restored` : `"${folder.name}" archived`);
            onDone();
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Create a folder (optionally inside `parentId`) or rename `folder`. */
export function FolderNameDialog({ open, folder, parentId, onOpenChange, onDone }: {
  open: boolean; folder?: LibraryFolder | null; parentId: string | null; onOpenChange: (o: boolean) => void; onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [pending, start] = useTransition();
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) { setName(folder?.name ?? ""); setInvalid(false); }
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = folder ? await renameFolder({ id: folder.id, name }) : await createFolder({ name, parentId });
      if (!r.ok) {
        setInvalid(true);
        toast.error(r.error);
        return;
      }
      toast.success(folder ? "Folder renamed" : `Folder "${name.trim()}" created`);
      onOpenChange(false);
      onDone();
    });
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{folder ? "Rename folder" : parentId ? "New subfolder" : "New folder"}</DialogTitle>
          <DialogDescription>{folder ? "Existing share links keep working." : "For example: Brochures, Price lists, Site photos."}</DialogDescription>
        </DialogHeader>
        <form id="folder-name" onSubmit={submit} noValidate>
          <FieldGroup>
            <Field data-invalid={invalid}>
              <FieldLabel htmlFor="folder-name-input">Name</FieldLabel>
              <Input id="folder-name-input" autoFocus maxLength={80} value={name} onChange={(e) => { setName(e.target.value); setInvalid(false); }} aria-invalid={invalid} />
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button type="submit" form="folder-name" disabled={pending || !name.trim()}>{pending && <Loader2 className="animate-spin" />}{folder ? "Save" : "Create folder"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
