"use client";

import { useRouter } from "next/navigation";
import { Check, ChevronRight, Copy, ExternalLink, Folder, FolderOpen, MoreHorizontal, Palette, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { COLOR_NAMES } from "@/components/common/color-swatch-picker";
import { DataPagination } from "@/components/common/data-pagination";
import { EmptyState, ErrorState, FetchingIndicator } from "@/components/common/states";
import { LateBadge, PhaseStatusBadge, ProjectStatusBadge } from "@/components/projects/project-badges";
import { TeamAvatars } from "@/components/projects/team-avatars";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLiveQuery } from "@/hooks/use-live-query";
import { PROJECT_TABLES } from "@/lib/permissions";
import { fetchFolderColors, fetchMonthProjects, fetchProjectMonths, type ProjectQuery } from "@/lib/project-queries";
import { groupYears, MONTH_NAMES, type ProjectListItem } from "@/lib/projects";
import { STAGE_COLORS, stageHex, type StageColor } from "@/lib/stages";
import { formatCalendarDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { setProjectColor, setProjectFolderColor } from "@/server/actions/projects";

const TABLES = [...PROJECT_TABLES];
const COLOR_TABLES = ["project_folder_colors"];
// Each month keeps its colour (never red: red means late here).
const MONTH_COLORS: StageColor[] = ["sky", "violet", "emerald", "amber", "orange", "pink", "blue", "sky", "violet", "emerald", "amber", "orange"];
const YEAR_COLOR: StageColor = "amber";

type Where = { year: number | null; month: number | null };

/**
 * Projects as folders, like a file manager: years → months (by start date) → the projects that started
 * that month. Counts come from the database (project_months) under the same filters as the list.
 */
export function ProjectFolders({ query, where, onGo, onPage }: {
  query: Pick<ProjectQuery, "status" | "late" | "page" | "pageSize">; where: Where;
  onGo: (w: Where) => void; onPage: (p: { page?: number; pageSize?: number }) => void;
}) {
  const me = useProfile();
  // Admins and architect managers colour folders (the database checks each project's manager too).
  const canColor = me.roles.includes("admin") || me.roles.includes("architect_manager");
  const colors = useLiveQuery({ queryKey: `project-folder-colors:${me.id}`, fetcher: fetchFolderColors, tables: COLOR_TABLES });
  const colorOf = (year: number, month: number | null) =>
    colors.data?.find((c) => c.year === year && c.month === month)?.color ?? (month ? MONTH_COLORS[month - 1] : YEAR_COLOR);
  const custom = (year: number, month: number | null) => Boolean(colors.data?.some((c) => c.year === year && c.month === month));
  const paintFolder = async (year: number, month: number | null, color: StageColor | null) => {
    const r = await setProjectFolderColor({ year, month, color });
    if (!r.ok) return void toast.error(r.error);
    colors.refetch();
  };
  const months = useLiveQuery({
    queryKey: `project-months:${me.id}:${query.status}:${query.late}`,
    fetcher: (s) => fetchProjectMonths(query, s), tables: TABLES,
  });
  const inMonth = where.year != null && where.month != null;
  const projects = useLiveQuery({
    queryKey: `month-projects:${me.id}:${query.status}:${query.late}:${where.year}:${where.month}:${query.page}:${query.pageSize}`,
    fetcher: (s) => fetchMonthProjects({ ...query, year: where.year!, month: where.month! }, s), tables: TABLES, enabled: inMonth,
  });

  if (months.error && !months.data) return <ErrorState message={months.error} onRetry={months.refetch} />;
  if (!months.data) return <TileSkeleton />;
  const years = groupYears(months.data.months);
  const year = years.find((y) => y.year === where.year) ?? null;
  const partial = months.data.partial;

  return (
    <div className="space-y-4">
      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
        <Crumb onClick={where.year != null ? () => onGo({ year: null, month: null }) : undefined}>All projects</Crumb>
        {where.year != null ? <><ChevronRight className="size-4 text-muted-foreground" /><Crumb onClick={inMonth ? () => onGo({ year: where.year, month: null }) : undefined}>{where.year}</Crumb></> : null}
        {inMonth ? <><ChevronRight className="size-4 text-muted-foreground" /><Crumb>{MONTH_NAMES[where.month! - 1]}</Crumb></> : null}
        <FetchingIndicator show={(months.isFetching && !months.isInitialLoading) || (projects.isFetching && !projects.isInitialLoading)} />
      </nav>

      {where.year == null ? (
        !years.length ? <EmptyState title="No projects here" description="Change the status filter, or create a project." /> : (
          <TileGrid>
            {years.map((y) => (
              <FolderTile key={y.year} color={colorOf(y.year, null)} title={String(y.year)} onOpen={() => onGo({ year: y.year, month: null })}
                href={`/projects?y=${y.year}`} lines={[`${y.total} project${y.total === 1 ? "" : "s"} · ${y.months.length} month${y.months.length === 1 ? "" : "s"}`]}
                late={partial ? 0 : y.late}
                onColor={canColor ? (c) => void paintFolder(y.year, null, c) : undefined} custom={custom(y.year, null)} />
            ))}
          </TileGrid>
        )
      ) : !inMonth ? (
        !year ? <EmptyState title={`No projects started in ${where.year}`} description="Change the status filter, or go back to all years." /> : (
          <TileGrid>
            {year.months.map((m) => (
              <FolderTile key={m.month} color={colorOf(m.year, m.month)} title={MONTH_NAMES[m.month - 1]} subtitle={String(m.year)}
                onOpen={() => onGo({ year: m.year, month: m.month })} href={`/projects?y=${m.year}&m=${m.month}`} late={partial ? 0 : m.late}
                onColor={canColor ? (c) => void paintFolder(m.year, m.month, c) : undefined} custom={custom(m.year, m.month)}
                lines={[`${m.total} project${m.total === 1 ? "" : "s"}${m.active && m.active !== m.total ? ` · ${m.active} active` : ""}`]} />
            ))}
          </TileGrid>
        )
      ) : projects.error && !projects.data ? <ErrorState message={projects.error} onRetry={projects.refetch} />
        : projects.isInitialLoading || !projects.data ? <TileSkeleton />
        : !projects.data.total ? <EmptyState title={`No projects started in ${MONTH_NAMES[where.month! - 1]} ${where.year}`} />
        : (
          <>
            <div className={cn(projects.isStale && "opacity-60")}>
              <TileGrid wide>
                {projects.data.items.map((p) => (
                  <ProjectFolder key={p.id} p={p} partial={projects.data!.partial}
                    onColor={canColor ? async (c) => { const r = await setProjectColor({ id: p.id, color: c }); if (!r.ok) toast.error(r.error); else projects.refetch(); } : undefined} />
                ))}
              </TileGrid>
            </div>
            <DataPagination page={query.page} pageSize={query.pageSize} total={projects.data.total} disabled={projects.isFetching}
              onPageChange={(page) => onPage({ page })} onPageSizeChange={(pageSize) => onPage({ pageSize })} />
          </>
        )}
      {partial ? <p className="text-xs text-muted-foreground">Late counts and phase details appear here once the latest database update is applied.</p> : null}
    </div>
  );
}

function Crumb({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return onClick
    ? <button type="button" className="rounded px-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground" onClick={onClick}>{children}</button>
    : <span className="px-1 font-medium">{children}</span>;
}

/** Folders in a grid; project folders (more to read) get wider columns. */
const TileGrid = ({ children, wide }: { children: React.ReactNode; wide?: boolean }) => (
  <div className={cn("grid gap-3", wide ? "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6")}>{children}</div>
);

function TileSkeleton() {
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="h-32 animate-pulse rounded-xl bg-muted/50" />)}</div>;
}

/**
 * A folder you open: a big tinted folder, its name and what's inside. Right-click (or the ⋯ button on touch
 * screens) to open it in a new tab, copy its link or change its colour.
 */
function FolderTile({ color, title, subtitle, lines, late, onOpen, href, onColor, custom, badge, children, bar }: {
  color: StageColor; title: string; subtitle?: string; lines: string[]; late: number; onOpen: () => void; href: string;
  onColor?: (c: StageColor | null) => void; custom?: boolean; badge?: React.ReactNode; children?: React.ReactNode;
  /** A slim progress bar along the bottom edge. */
  bar?: { pct: number; label: string; bad?: boolean };
}) {
  const hex = stageHex(color);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group relative flex overflow-hidden rounded-xl border transition-colors hover:bg-accent/30 focus-within:ring-2 focus-within:ring-ring"
          style={{ borderColor: `${hex}40`, background: `${hex}0d` }}>
          <button type="button" onClick={onOpen} aria-label={`Open ${title}${subtitle ? ` ${subtitle}` : ""}`}
            className="flex min-w-0 flex-1 flex-col items-start gap-2 p-4 text-left focus-visible:outline-none">
            <span className="flex w-full items-start gap-2">
              <Folder className="size-11 shrink-0 transition-transform group-hover:-translate-y-0.5" strokeWidth={1.5} style={{ color: hex, fill: `${hex}33` }} aria-hidden />
              <span className="flex-1" />
              {badge}
            </span>
            <span className="w-full min-w-0">
              <span className="flex items-baseline gap-1.5">
                <span className="line-clamp-2 text-base font-semibold break-words">{title}</span>
                {subtitle ? <span className="text-xs text-muted-foreground">{subtitle}</span> : null}
              </span>
              {lines.map((l) => <span key={l} className="block truncate text-xs text-muted-foreground">{l}</span>)}
              {late ? <span className="mt-1 block text-xs font-medium text-red-300">{late} late</span> : null}
              {children}
            </span>
          </button>
          <FolderMenu kind="dropdown" title={title} href={href} color={color} onOpen={onOpen} onColor={onColor} custom={custom} />
          {bar ? (
            <span className="absolute inset-x-0 bottom-0 h-1 bg-white/[0.06]" role="progressbar" aria-valuenow={bar.pct} aria-valuemin={0} aria-valuemax={100} aria-label={bar.label} title={bar.label}>
              <span className={cn("block h-full", bar.bad ? "bg-red-400" : "bg-emerald-400")} style={{ width: `${bar.pct}%` }} />
            </span>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <FolderMenu kind="context" title={title} href={href} color={color} onOpen={onOpen} onColor={onColor} custom={custom} />
    </ContextMenu>
  );
}

/** The same actions as a right-click menu or behind the ⋯ button. */
function FolderMenu({ kind, title, href, color, onOpen, onColor, custom }: {
  kind: "context" | "dropdown"; title: string; href: string; color: StageColor; onOpen: () => void; onColor?: (c: StageColor | null) => void; custom?: boolean;
}) {
  const M = kind === "context"
    ? { Content: ContextMenuContent, Item: ContextMenuItem, Sep: ContextMenuSeparator, Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent }
    : { Content: DropdownMenuContent, Item: DropdownMenuItem, Sep: DropdownMenuSeparator, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).toString());
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };
  const items = (
    <M.Content className="w-52" {...(kind === "dropdown" ? { align: "end" as const } : {})}>
      <M.Item onSelect={onOpen}><FolderOpen /> Open</M.Item>
      <M.Item onSelect={() => window.open(href, "_blank", "noopener")}><ExternalLink /> Open in new tab</M.Item>
      <M.Item onSelect={() => void copy()}><Copy /> Copy link</M.Item>
      {onColor ? (
        <>
          <M.Sep />
          <M.Sub>
            <M.SubTrigger><Palette /> Colour</M.SubTrigger>
            <M.SubContent className="w-44">
              {STAGE_COLORS.map((c) => (
                <M.Item key={c} onSelect={() => onColor(c)}>
                  <span className="size-3.5 rounded-full" style={{ background: stageHex(c) }} aria-hidden />{COLOR_NAMES[c]}
                  {c === color ? <Check className="ml-auto" /> : null}
                </M.Item>
              ))}
              {custom ? <><M.Sep /><M.Item onSelect={() => onColor(null)}><RotateCcw /> Default colour</M.Item></> : null}
            </M.SubContent>
          </M.Sub>
        </>
      ) : null}
    </M.Content>
  );
  if (kind === "context") return items;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="absolute top-2 right-2 opacity-70 hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 data-[state=open]:opacity-100"
          aria-label={`More for ${title}`}><MoreHorizontal /></Button>
      </DropdownMenuTrigger>
      {items}
    </DropdownMenu>
  );
}

/** A project inside a month folder, as a folder in the project's own colour: opens the project. */
function ProjectFolder({ p, partial, onColor }: { p: ProjectListItem; partial: boolean; onColor?: (c: StageColor | null) => void }) {
  const router = useRouter();
  const href = `/projects/${p.id}`;
  const pct = p.phases_total ? Math.round((p.phases_done / p.phases_total) * 100) : 0;
  const ph = p.current_phase;
  return (
    <FolderTile color={p.color} title={p.name} href={href} onOpen={() => router.push(href)} late={0}
      lines={[`${p.code} · ${p.client_name}`]}
      onColor={onColor ? (c) => c && onColor(c) : undefined}
      badge={p.status !== "active" ? <ProjectStatusBadge status={p.status} /> : undefined}
      bar={partial || !p.phases_total ? undefined : { pct, label: `${p.phases_done} of ${p.phases_total} phases done`, bad: p.late_phases > 0 }}>
      {partial ? null : (
        <span className="mt-3 block space-y-1.5">
          {ph ? (
            <>
              <span className="block text-xs text-muted-foreground">Now</span>
              <span className="line-clamp-2 block text-sm break-words">{ph.name}</span>
              <span className="flex flex-wrap items-center gap-1.5">
                <PhaseStatusBadge status={ph.status} />
                {p.late_phases ? <LateBadge days={p.max_late_days} /> : <span className="text-xs text-muted-foreground">due {formatCalendarDate(ph.deadline)}</span>}
              </span>
            </>
          ) : <span className="block text-sm text-muted-foreground">{p.phases_total ? "All phases finished" : "No phases yet"}</span>}
        </span>
      )}
      <span className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="tabular-nums">{formatCalendarDate(p.start_date)} – {formatCalendarDate(p.end_date)}</span>
        {!partial && p.team.length ? <TeamAvatars team={p.team} max={3} /> : null}
      </span>
    </FolderTile>
  );
}
