"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, ArrowLeft, GitMerge, Loader2, Pencil, Search } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DataPagination } from "@/components/common/data-pagination";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { NicheCombobox, type NicheValue } from "@/components/leads/niche-combobox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { formatCount } from "@/lib/format";
import { lastPage, parsePaging } from "@/lib/pagination";
import { fetchNicheAdmin, type NicheAdminRow } from "@/lib/queries";
import { cleanSearch } from "@/lib/search";
import type { NicheOption } from "@/lib/types";
import { mergeNiches, renameNiche, setNicheArchived } from "@/server/actions/niches";

export function NichesAdmin({ initialNiches }: { initialNiches: NicheOption[] }) {
  const { params, set } = useUrlState();
  const query = useMemo(() => ({ ...parsePaging(params), q: cleanSearch(params.get("q")), archived: params.get("archived") === "1" }), [params]);
  const [input, setInput] = useState(query.q);
  const debounced = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debounced !== query.q) set({ q: debounced }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const { data, error, isFetching, isInitialLoading, isStale, refetch } = useLiveQuery({
    queryKey: `niche-admin:${JSON.stringify(query)}`,
    fetcher: (s) => fetchNicheAdmin(query, s),
    tables: ["niches", "leads"],
  });
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
  }, [data, isStale, query.page, query.pageSize, set]);

  const [rename, setRename] = useState<NicheAdminRow | null>(null);
  const [merge, setMerge] = useState<NicheAdminRow | null>(null);

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2"><Link href="/leads"><ArrowLeft /> Leads</Link></Button>
      <PageHeader title="Niches" description="Rename, merge or archive niche options. Existing leads keep valid references." />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="pl-8" placeholder="Search niches" value={input} maxLength={60} onChange={(e) => setInput(e.target.value)} aria-label="Search niches" />
        </div>
        <Tabs value={query.archived ? "archived" : "active"} onValueChange={(v) => set({ archived: v === "archived" ? "1" : null })}>
          <TabsList><TabsTrigger value="active">Active</TabsTrigger><TabsTrigger value="archived">Archived</TabsTrigger></TabsList>
        </Tabs>
        <FetchingIndicator show={isFetching && !isInitialLoading} />
      </div>
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : isInitialLoading ? <ListSkeleton /> : !data?.total ? (
        <EmptyState title="No niches found" description="Niches are created from the lead form." />
      ) : (
        <>
          <Card className="divide-y py-0">
            {data.items.map((n) => (
              <div key={n.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">{n.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatCount(n.leads[0]?.count ?? 0)} leads
                    {n.merged_into_id ? <Badge variant="outline" className="ml-2">Merged</Badge> : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {!n.archived_at ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setRename(n)}><Pencil /> Rename</Button>
                      <Button size="sm" variant="outline" onClick={() => setMerge(n)}><GitMerge /> Merge</Button>
                    </>
                  ) : null}
                  {!n.merged_into_id ? (
                    <ConfirmDialog
                      trigger={<Button size="sm" variant="ghost">{n.archived_at ? <><ArchiveRestore /> Restore</> : <><Archive /> Archive</>}</Button>}
                      title={n.archived_at ? `Restore “${n.name}”?` : `Archive “${n.name}”?`}
                      description={n.archived_at ? "It will be selectable for leads again." : "Existing leads keep this niche, but it can't be chosen for new leads."}
                      confirmLabel={n.archived_at ? "Restore" : "Archive"}
                      destructive={!n.archived_at}
                      onConfirm={async () => {
                        const r = await setNicheArchived({ id: n.id, archived: !n.archived_at });
                        if (!r.ok) { toast.error(r.error); return false; }
                        toast.success(n.archived_at ? "Niche restored" : "Niche archived");
                        refetch();
                      }}
                    />
                  ) : null}
                </div>
              </div>
            ))}
          </Card>
          <DataPagination page={query.page} pageSize={query.pageSize} total={data.total} disabled={isFetching}
            onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s) })} />
        </>
      )}
      <RenameDialog niche={rename} onClose={() => setRename(null)} onDone={refetch} />
      <MergeDialog niche={merge} initialNiches={initialNiches} onClose={() => setMerge(null)} onDone={refetch} />
    </>
  );
}

function RenameDialog({ niche, onClose, onDone }: { niche: NicheAdminRow | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  useEffect(() => setName(niche?.name ?? ""), [niche]);
  return (
    <Dialog open={!!niche} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Rename niche</DialogTitle><DialogDescription>All leads using it show the new name.</DialogDescription></DialogHeader>
        <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Niche name" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button disabled={pending || !name.trim()} onClick={() => start(async () => {
            const r = await renameNiche({ id: niche!.id, name });
            if (!r.ok) return void toast.error(r.error);
            toast.success("Niche renamed");
            onClose();
            onDone();
          })}>{pending && <Loader2 className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MergeDialog({ niche, initialNiches, onClose, onDone }: { niche: NicheAdminRow | null; initialNiches: NicheOption[]; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = useState<NicheValue>(null);
  const [pending, start] = useTransition();
  useEffect(() => setTarget(null), [niche]);
  return (
    <Dialog open={!!niche} onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge “{niche?.name}”</DialogTitle>
          <DialogDescription>Its leads move to the target niche, and “{niche?.name}” is archived. Future saves of this name use the target.</DialogDescription>
        </DialogHeader>
        <NicheCombobox value={target} onChange={setTarget} initialOptions={initialNiches.filter((n) => n.id !== niche?.id)} allowCreate={false} placeholder="Choose target niche" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button disabled={pending || !target?.id || target.id === niche?.id} onClick={() => start(async () => {
            const r = await mergeNiches({ sourceId: niche!.id, targetId: target!.id });
            if (!r.ok) return void toast.error(r.error);
            toast.success(`Merged · ${r.data.movedLeads} leads moved`);
            onClose();
            onDone();
          })}>{pending && <Loader2 className="animate-spin" />}Merge</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
