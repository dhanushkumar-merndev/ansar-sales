"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChartGantt, FolderPlus, ListPlus, Maximize2, Minimize2, PanelRightOpen, Pencil, Plus, Printer, Sheet as SheetIcon } from "lucide-react";
import { GanttChart } from "@/components/projects/timeline/gantt-chart";
import type { GanttHit } from "@/components/projects/timeline/gantt-impl";
import { PhaseAddDialog, type PhaseAddTarget } from "@/components/projects/timeline/phase-add-dialog";
import { PhaseDrawer } from "@/components/projects/timeline/phase-drawer";
import { PhaseSheet } from "@/components/projects/timeline/phase-sheet";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useLiveQuery } from "@/hooks/use-live-query";
import { useUrlState } from "@/hooks/use-url-state";
import { fetchPhaseHistory } from "@/lib/project-queries";
import type { Phase, ProjectDetail } from "@/lib/projects";
import { addDays, istToday } from "@/lib/time";
import { STATUS_COLORS } from "@/components/projects/timeline/gantt-colors";
import { cn } from "@/lib/utils";

// The process strip lives on the Overview; an old ?view=process link falls back to the Gantt.
const VIEWS = { gantt: { label: "Gantt", icon: ChartGantt }, sheet: { label: "Sheet", icon: SheetIcon } } as const;
type View = keyof typeof VIEWS;
type Range = "project" | "month" | "next30";

/**
 * Full screen for the timeline: the browser's full screen where it exists, else (iPhone Safari) a fixed
 * overlay. Esc leaves either.
 */
function useFullscreen() {
  const ref = useRef<HTMLDivElement>(null);
  const [native, setNative] = useState(false);
  const [overlay, setOverlay] = useState(false);
  useEffect(() => {
    const sync = () => setNative(document.fullscreenElement === ref.current && ref.current !== null);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOverlay(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay]);
  const exit = useCallback(async () => {
    setOverlay(false);
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  }, []);
  const toggle = useCallback(async () => {
    if (native || overlay) return exit();
    const el = ref.current;
    if (el?.requestFullscreen && document.fullscreenEnabled) await el.requestFullscreen().catch(() => setOverlay(true));
    else setOverlay(true);
  }, [native, overlay, exit]);
  return { ref, full: native || overlay, overlay, toggle, exit };
}

export function ProjectTimelineTab({ detail, onChanged, onOpenPhase }: { detail: ProjectDetail; onChanged: () => void; onOpenPhase: (p: Phase) => void }) {
  const { ref: fullRef, full, overlay, toggle: toggleFull, exit: exitFull } = useFullscreen();
  // The phase drawer opens over the page, outside the full-screen view: leave full screen first.
  const openPhase = (ph: Phase) => { if (full) void exitFull().then(() => onOpenPhase(ph)); else onOpenPhase(ph); };
  const { params, set } = useUrlState();
  const raw = params.get("view");
  const view: View = raw && raw in VIEWS ? (raw as View) : "gantt";
  const [range, setRange] = useState<Range>("project");
  const [creating, setCreating] = useState(false);
  // Right-click on the Gantt: the row (or stage name) it was on, and what the menu then asked to add.
  const [menu, setMenu] = useState<GanttHit | null>(null);
  const [adding, setAdding] = useState<PhaseAddTarget | null>(null);
  const today = istToday();
  const { project: p, phases } = detail;
  const history = useLiveQuery({
    queryKey: `phase-history:${p.id}`, fetcher: (s) => fetchPhaseHistory(p.id, s), enabled: view === "gantt", tables: ["project_activities", "project_phases"],
  });
  const visible = range === "month" ? { from: `${today.slice(0, 8)}01`, to: addDays(`${addDays(`${today.slice(0, 8)}01`, 32).slice(0, 8)}01`, -1) }
    : range === "next30" ? { from: addDays(today, -3), to: addDays(today, 30) } : undefined;

  return (
    <div ref={fullRef} className={cn("space-y-3", full && "overflow-auto bg-background p-4", overlay && "fixed inset-0 z-50")}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border p-0.5" role="tablist" aria-label="Timeline view">
          {(Object.keys(VIEWS) as View[]).map((v) => {
            const V = VIEWS[v];
            return (
              <button key={v} type="button" role="tab" aria-selected={v === view} onClick={() => set({ view: v === "gantt" ? null : v })}
                className={cn("inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm", v === view ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>
                <V.icon className="size-4" />{V.label}
              </button>
            );
          })}
        </div>
        {view === "gantt" ? (
          <div className="inline-flex rounded-lg border p-0.5" aria-label="Visible dates">
            {([["project", "Whole project"], ["month", "This month"], ["next30", "Next 30 days"]] as [Range, string][]).map(([r, label]) => (
              <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}
                className={cn("rounded-md px-2.5 py-1 text-sm", r === range ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}>{label}</button>
            ))}
          </div>
        ) : null}
        <span className="flex-1" />
        {full ? <span className="text-sm font-medium">{p.name}</span> : null}
        <Button variant="outline" size="sm" onClick={() => void toggleFull()} aria-pressed={full}>
          {full ? <><Minimize2 /> Exit full screen</> : <><Maximize2 /> Full screen</>}
        </Button>
        {!full ? <Button variant="outline" size="sm" asChild><Link href={`/print/projects/${p.id}`} target="_blank"><Printer /> Print / PDF</Link></Button> : null}
        {detail.can.manage && !full ? <Button size="sm" onClick={() => setCreating(true)}><Plus /> Add phase</Button> : null}
      </div>

      <Card className="py-0">
        <CardContent className={cn("p-0", view !== "sheet" && "p-3 sm:p-4")}>
          {view === "sheet" ? <PhaseSheet detail={detail} onOpen={openPhase} onChanged={onChanged} />
            : phases.length ? (
              <>
                <ContextMenu modal={false}>
                  <ContextMenuTrigger asChild>
                    <div>
                      <GanttChart phases={phases} projectStart={p.start_date} projectEnd={p.end_date} originalEnd={p.original_end_date} history={history.data} today={today} range={visible} fill={full} onOpen={openPhase}
                        onContextMenu={(hit, e) => { if (!hit && !detail.can.manage) e.preventDefault(); else setMenu(hit); }} />
                    </div>
                  </ContextMenuTrigger>
                  <GanttMenu hit={menu} detail={detail} onOpen={openPhase} onAdd={(t) => { if (full) void exitFull().then(() => setAdding(t)); else setAdding(t); }} />
                </ContextMenu>
                <Legend />
              </>
            ) : <p className="text-sm text-muted-foreground">No phases yet.</p>}
        </CardContent>
      </Card>

      <PhaseDrawer phase={null} creating={creating} detail={detail} onClose={() => setCreating(false)} onChanged={onChanged} />
      <PhaseAddDialog target={adding} detail={detail} onClose={() => setAdding(null)} onChanged={onChanged} />
    </div>
  );
}

/**
 * The Gantt's right-click menu. On a phase: open it, add a phase right below it, or start a new stage after
 * its stage. On a stage name: add a phase at the end of that stage, a new stage after it, or rename it.
 * Elsewhere (managers): add at the end. Only managers add; everyone can open.
 */
function GanttMenu({ hit, detail, onOpen, onAdd }: {
  hit: GanttHit | null; detail: ProjectDetail; onOpen: (p: Phase) => void; onAdd: (t: PhaseAddTarget) => void;
}) {
  const manage = detail.can.manage;
  if (!hit) {
    return (
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={() => onAdd({ kind: "phase", category: detail.phases.at(-1)?.category ?? "Design" })}><ListPlus /> Add a phase at the end</ContextMenuItem>
        <ContextMenuItem onSelect={() => onAdd({ kind: "stage", after: detail.phases.at(-1)?.category })}><FolderPlus /> Add a stage at the end</ContextMenuItem>
      </ContextMenuContent>
    );
  }
  const { phase, heading } = hit;
  const stage = phase.category;
  // The last phase of this stage's run of rows (a new stage goes after it).
  const at = detail.phases.findIndex((x) => x.id === phase.id);
  let end = at;
  while (end + 1 < detail.phases.length && detail.phases[end + 1].category === stage) end++;
  const lastOfStage = detail.phases[end]?.id;
  return (
    <ContextMenuContent className="w-64">
      <ContextMenuLabel className="truncate text-xs text-muted-foreground">{heading ? `Stage · ${stage}` : phase.name}</ContextMenuLabel>
      <ContextMenuItem onSelect={() => onOpen(phase)}><PanelRightOpen /> Open {heading ? `“${phase.name}”` : "phase"}</ContextMenuItem>
      {manage ? (
        <>
          <ContextMenuSeparator />
          {heading
            ? <ContextMenuItem onSelect={() => onAdd({ kind: "phase", category: stage, afterId: lastOfStage })}><ListPlus /> Add a phase to {stage}</ContextMenuItem>
            : <ContextMenuItem onSelect={() => onAdd({ kind: "phase", category: stage, afterId: phase.id })}><ListPlus /> Add a phase below</ContextMenuItem>}
          <ContextMenuItem onSelect={() => onAdd({ kind: "stage", afterId: lastOfStage, after: stage })}><FolderPlus /> Add a stage after {stage}</ContextMenuItem>
          {heading ? <ContextMenuItem onSelect={() => onAdd({ kind: "rename", category: stage })}><Pencil /> Rename stage</ContextMenuItem> : null}
        </>
      ) : null}
    </ContextMenuContent>
  );
}

const STATUS_TRACK = [["In progress", STATUS_COLORS.in_progress], ["In review", STATUS_COLORS.in_review], ["Changes requested", STATUS_COLORS.changes_requested]] as const;

function Legend() {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
      <li className="inline-flex items-center gap-1.5"><span className="h-2.5 w-5 rounded-sm border border-dashed border-sky-400/70 bg-sky-400/20" />Planned</li>
      {STATUS_TRACK.map(([label, color]) => (
        <li key={label} className="inline-flex items-center gap-1.5"><span className="h-1 w-5 rounded-full" style={{ background: color }} />{label}</li>
      ))}
      <li className="inline-flex items-center gap-1.5"><span className="h-0.5 w-5 rounded-full bg-red-400" />Past the deadline</li>
      <li className="inline-flex items-center gap-1.5"><span className="h-3 w-px border-l border-dashed border-red-400" />Now</li>
      <li className="inline-flex items-center gap-1.5"><span className="text-emerald-400">✓</span>Done</li>
      <li className="inline-flex items-center gap-1.5"><span className="h-3 w-0.5 rounded-full bg-violet-400" />Status changed</li>
      <li className="inline-flex items-center gap-1.5"><span className="inline-flex size-3.5 items-center justify-center rounded-full bg-orange-400 text-[9px] font-bold text-black">3</span>Changes close together (zoom in)</li>
      <li>Hover a part for its details</li>
    </ul>
  );
}
