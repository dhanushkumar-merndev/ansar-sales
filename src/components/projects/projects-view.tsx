"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, FolderTree, Hand, List, Plus, Search } from "lucide-react";
import { DataPagination } from "@/components/common/data-pagination";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { CreateProjectDialog, type ProjectSourceLead } from "@/components/projects/create-project-dialog";
import { ProjectStatusBadge } from "@/components/projects/project-badges";
import { ProjectFolders } from "@/components/projects/project-folders";
import { CurrentPhase, Progress } from "@/components/projects/project-list-bits";
import { TeamAvatars } from "@/components/projects/team-avatars";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { SEARCH_DEBOUNCE_MS } from "@/lib/constants";
import { lastPage, parsePaging } from "@/lib/pagination";
import { fetchHandoffLeads, fetchProjects, type ProjectQuery } from "@/lib/project-queries";
import { PROJECT_TABLES } from "@/lib/permissions";
import { cleanSearch } from "@/lib/search";
import { formatCalendarDate, formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

const STATUS_FILTERS: { value: ProjectQuery["status"]; label: string }[] = [
  { value: "open", label: "Open (active + on hold)" }, { value: "active", label: "Active" }, { value: "on_hold", label: "On hold" },
  { value: "completed", label: "Completed" }, { value: "cancelled", label: "Cancelled" }, { value: "all", label: "All" },
];
const SORTS: { value: ProjectQuery["sort"]; label: string }[] = [
  { value: "end_date", label: "Due soonest" }, { value: "created", label: "Newest" }, { value: "name", label: "Name" }, { value: "code", label: "Code" },
];
const TABLES = [...PROJECT_TABLES];

export function ProjectsView() {
  const me = useProfile();
  const router = useRouter();
  const isAdmin = me.roles.includes("admin");
  const { params, set } = useUrlState();
  const query = useMemo<ProjectQuery>(() => {
    const status = params.get("status");
    const sort = params.get("sort");
    return {
      ...parsePaging(params),
      q: cleanSearch(params.get("q")),
      status: (STATUS_FILTERS.find((s) => s.value === status)?.value ?? "open"),
      sort: (SORTS.find((s) => s.value === sort)?.value ?? "end_date"),
      late: params.get("late") === "1",
      member: null,
    };
  }, [params]);
  // Folders (years → months → projects) unless the list is chosen; a search always shows the matching list.
  const asList = params.get("view") === "list" || Boolean(query.q);
  const num = (k: string) => { const v = Number(params.get(k)); return Number.isInteger(v) && v > 0 ? v : null; };
  const where = { year: num("y"), month: (() => { const m = num("m"); return m && m <= 12 ? m : null; })() };
  const [input, setInput] = useState(query.q);
  const debounced = useDebouncedValue(cleanSearch(input), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debounced !== query.q) set({ q: debounced }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const projects = useLiveQuery({
    queryKey: `projects:${me.id}:${JSON.stringify(query)}`,
    fetcher: (s) => fetchProjects(query, s),
    tables: TABLES,
    enabled: asList,
  });
  const { data, isStale } = projects;
  useEffect(() => {
    if (data && !isStale && data.items.length === 0 && data.total > 0 && query.page > 1) set({ page: String(lastPage(data.total, query.pageSize)) }, { replace: true });
  }, [data, isStale, query.page, query.pageSize, set]);

  const handoffs = useLiveQuery({ queryKey: `handoffs:${me.id}`, fetcher: fetchHandoffLeads, tables: ["leads", "projects"], enabled: isAdmin });
  const [creating, setCreating] = useState<{ lead: ProjectSourceLead | null } | null>(null);

  return (
    <>
      <PageHeader
        title="Projects"
        description={isAdmin ? "Every project of the company, its phase and whether it is on time." : "Projects you are on, their current phase and deadlines."}
        actions={isAdmin ? <Button onClick={() => setCreating({ lead: null })}><Plus /> New project</Button> : null}
      />

      {isAdmin && (handoffs.data?.length ?? 0) > 0 ? (
        <Card className="mb-4 gap-0 border-amber-400/30 py-0">
          <div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm font-medium">
            <Hand className="size-4 text-amber-300" /> Ready for a project
            <span className="text-muted-foreground">· handed over by BDMs</span>
          </div>
          <ul className="divide-y">
            {handoffs.data!.map((l) => (
              <li key={l.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <Link href={`/leads/${l.id}`} className="font-medium hover:underline">{l.name}</Link>
                  <span className="ml-2 text-xs text-muted-foreground">{l.phone} · by {l.handed_by ?? l.owner.display_name} · {formatRelative(l.handoff_at)}</span>
                  {l.handoff_note ? <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">“{l.handoff_note}”</p> : null}
                </div>
                <Button size="sm" onClick={() => setCreating({ lead: { id: l.id, name: l.name, phone: l.phone, email: l.email } })}>
                  Create project <ArrowRight />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="pl-8" placeholder="Search project, client, code or phone" value={input} maxLength={100}
            onChange={(e) => setInput(e.target.value)} aria-label="Search projects" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border p-0.5" role="tablist" aria-label="Projects view">
            {([["folders", "Folders", FolderTree], ["list", "List", List]] as const).map(([v, label, Icon]) => {
              const on = (v === "list") === (params.get("view") === "list");
              return (
                <button key={v} type="button" role="tab" aria-selected={on} onClick={() => set({ view: v === "list" ? "list" : null, page: null })}
                  className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm", on ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>
                  <Icon className="size-4" />{label}
                </button>
              );
            })}
          </div>
          <Select value={query.status} onValueChange={(v) => set({ status: v === "open" ? null : v })}>
            <SelectTrigger className="w-[200px]" aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>{STATUS_FILTERS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
          {asList ? <Select value={query.sort} onValueChange={(v) => set({ sort: v === "end_date" ? null : v })}>
            <SelectTrigger className="w-[150px]" aria-label="Sort"><SelectValue /></SelectTrigger>
            <SelectContent>{SORTS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
          </Select> : null}
          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm">
            <Checkbox checked={query.late} onCheckedChange={(v) => set({ late: v === true ? "1" : null })} /> Late only
          </label>
          <FetchingIndicator show={projects.isFetching && !projects.isInitialLoading} />
        </div>
      </div>

      {!asList ? (
        <ProjectFolders query={query} where={where}
          onGo={(w) => set({ y: w.year != null ? String(w.year) : null, m: w.month != null ? String(w.month) : null, page: null })}
          onPage={(p) => set({ ...(p.page ? { page: String(p.page) } : {}), ...(p.pageSize ? { pageSize: String(p.pageSize), page: null } : {}) })} />
      ) : null}
      {asList && query.q && params.get("view") !== "list" ? <p className="mb-2 text-xs text-muted-foreground">Matching projects from every month. Clear the search to go back to the folders.</p> : null}
      {!asList ? null : projects.error && !data ? <ErrorState message={projects.error} onRetry={projects.refetch} /> : projects.isInitialLoading ? <ListSkeleton /> : !data?.total ? (
        <EmptyState title={query.q || query.late || query.status !== "open" ? "No projects match" : "No projects yet"}
          description={isAdmin ? "Create one from a handed-over lead, or with New project." : "Projects you are added to appear here."} />
      ) : (
        <div className={cn(isStale && "opacity-60")}>
          <Card className="hidden py-0 md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Current phase</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead>Team</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((p) => (
                  <TableRow key={p.id} className="cursor-pointer" onClick={() => router.push(`/projects/${p.id}`)}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Link href={`/projects/${p.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                        {p.status !== "active" ? <ProjectStatusBadge status={p.status} /> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">{p.code} · {p.client_name}</div>
                    </TableCell>
                    <TableCell><CurrentPhase p={p} /></TableCell>
                    <TableCell><Progress p={p} /></TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {formatCalendarDate(p.start_date)} – {formatCalendarDate(p.end_date)}
                    </TableCell>
                    <TableCell><TeamAvatars team={p.team} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <div className="space-y-2 md:hidden">
            {data.items.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="block">
                <Card className="py-0">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-muted-foreground">{p.code} · {p.client_name}</div>
                      </div>
                      {p.status !== "active" ? <ProjectStatusBadge status={p.status} /> : null}
                    </div>
                    <CurrentPhase p={p} />
                    <Progress p={p} />
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Due {formatCalendarDate(p.end_date)}</span>
                      <TeamAvatars team={p.team} />
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
          <DataPagination page={query.page} pageSize={query.pageSize} total={data.total} disabled={projects.isFetching}
            onPageChange={(p) => set({ page: String(p) })} onPageSizeChange={(s) => set({ pageSize: String(s) })} />
        </div>
      )}

      <CreateProjectDialog open={!!creating} onOpenChange={(o) => !o && setCreating(null)} lead={creating?.lead}
        onCreated={(id) => router.push(`/projects/${id}`)} />
    </>
  );
}
