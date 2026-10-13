"use client";

import { useState } from "react";
import { CircleDot, Search, Trophy, X } from "lucide-react";
import { DataPagination } from "@/components/common/data-pagination";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { cleanSearch } from "@/lib/search";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";

type PortalLead = {
  id: string; name: string; company_name: string | null; phone: string; email: string | null;
  stage: string | null; status: "open" | "won" | "lost"; source: "manual" | "facebook" | null; created_at: string;
};
type Page = { items: PortalLead[]; total: number };

const OUTCOME = {
  open: { icon: CircleDot, label: "Open", tone: "border-sky-400/30 bg-sky-400/10 text-sky-300" },
  won: { icon: Trophy, label: "Won", tone: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" },
  lost: { icon: X, label: "Lost", tone: "border-white/10 bg-white/5 text-zinc-400" },
} as const;

function StageBadge({ lead }: { lead: PortalLead }) {
  const o = OUTCOME[lead.status] ?? OUTCOME.open;
  return (
    <Badge variant="outline" className={cn("gap-1.5 font-medium", o.tone)}>
      <o.icon className="size-3 shrink-0" aria-hidden />{lead.stage ?? o.label}
    </Badge>
  );
}

const sourceLabel = (s: PortalLead["source"]) => (s === "facebook" ? "Facebook form" : "Added by the team");

/** The client's leads in its portal: list only, read-only. A client can't subscribe to leads, so it polls. */
export function PortalLeads() {
  const [input, setInput] = useState("");
  const q = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  const [requested, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // When leads went away (archived by the team), stay on the last page that still has some.
  const [total, setTotal] = useState<number | null>(null);
  const page = total === null ? requested : Math.min(requested, Math.max(1, Math.ceil(total / pageSize)));

  const leads = useLiveQuery({
    queryKey: `portal-leads:${q}:${page}:${pageSize}`,
    fetcher: async (signal) => {
      const { data, error } = await createClient()
        .rpc("portal_leads", { p_search: q || undefined, p_limit: pageSize, p_offset: (page - 1) * pageSize }).abortSignal(signal);
      if (error) throw error;
      const result = data as unknown as Page;
      setTotal(result.total);
      return result;
    },
    pollMs: 60_000,
  });
  const d = leads.data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={input} onChange={(e) => { setInput(e.target.value); setPage(1); }} placeholder="Search name, phone or email" className="pl-8" aria-label="Search leads" maxLength={100} />
        </div>
        <FetchingIndicator show={leads.isFetching && !leads.isInitialLoading} />
        {d ? <span className="ml-auto text-sm text-muted-foreground">{d.total} lead{d.total === 1 ? "" : "s"}</span> : null}
      </div>

      {leads.error && !d ? <ErrorState message={leads.error} onRetry={leads.refetch} />
        : !d ? <ListSkeleton rows={8} />
        : !d.total ? <EmptyState title={q ? "No leads match" : "No leads yet"} description={q ? undefined : "New leads show up here as they come in."} />
        : (
          <div className={cn("space-y-3", leads.isStale && "opacity-60")}>
            <Card className="hidden gap-0 overflow-hidden py-0 md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead><TableHead>Phone</TableHead><TableHead>Email</TableHead>
                    <TableHead>Stage</TableHead><TableHead>Source</TableHead><TableHead>Added</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.items.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>
                        <div className="font-medium">{l.name}</div>
                        {l.company_name ? <div className="text-xs text-muted-foreground">{l.company_name}</div> : null}
                      </TableCell>
                      <TableCell className="tabular-nums">{l.phone}</TableCell>
                      <TableCell className="text-muted-foreground">{l.email ?? "—"}</TableCell>
                      <TableCell><StageBadge lead={l} /></TableCell>
                      <TableCell className="text-muted-foreground">{sourceLabel(l.source)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(l.created_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            <ul className="space-y-2 md:hidden">
              {d.items.map((l) => (
                <li key={l.id}>
                  <Card className="gap-1.5 px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium">{l.name}</div>
                        {l.company_name ? <div className="text-xs text-muted-foreground">{l.company_name}</div> : null}
                      </div>
                      <StageBadge lead={l} />
                    </div>
                    <div className="text-sm tabular-nums">{l.phone}</div>
                    {l.email ? <div className="truncate text-sm text-muted-foreground">{l.email}</div> : null}
                    <div className="text-xs text-muted-foreground">{sourceLabel(l.source)} · {formatDateTime(l.created_at)}</div>
                  </Card>
                </li>
              ))}
            </ul>
            <DataPagination page={page} pageSize={pageSize} total={d.total} disabled={leads.isFetching}
              onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
          </div>
        )}
    </div>
  );
}
