"use client";

import { useState, useTransition } from "react";
import { CheckCheck, ClipboardPen, Loader2, Plus, RotateCcw, Users } from "lucide-react";
import { toast } from "sonner";
import { DateField } from "@/components/common/date-time-field";
import { RichTextEditor, RichTextView, type RichDoc } from "@/components/common/rich-text";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveQuery } from "@/hooks/use-live-query";
import { fetchSiteLogs, fetchSnags } from "@/lib/project-queries";
import { SNAG_STATUS_LABELS, type ProjectDetail, type SiteLog, type Snag } from "@/lib/projects";
import { STAGE_BADGE } from "@/lib/stages";
import { formatCalendarDate, formatRelative, istToday } from "@/lib/time";
import { cn } from "@/lib/utils";
import { saveSiteLog, saveSnag, setSnagStatus } from "@/server/actions/execution";

/** Daily site logs: what was done, how many workers, any issues. */
export function SiteLogsCard({ detail }: { detail: ProjectDetail }) {
  const me = useProfile();
  const projectId = detail.project.id;
  const [limit, setLimit] = useState(14);
  const q = useLiveQuery({ queryKey: `site-logs:${me.id}:${projectId}:${limit}`, fetcher: (s) => fetchSiteLogs(projectId, limit, s), tables: ["project_site_logs"] });
  const [editing, setEditing] = useState<{ log: SiteLog | null } | null>(null);
  const today = istToday();
  const mineToday = q.data?.find((l) => l.log_date === today && l.created_by === me.id) ?? null;
  return (
    <Card className="gap-0">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Site log</CardTitle>
        <Button size="sm" onClick={() => setEditing({ log: mineToday })}><ClipboardPen /> {mineToday ? "Edit today's log" : "Log today"}</Button>
      </CardHeader>
      <CardContent>
        {q.error && !q.data ? <ErrorState message={q.error} onRetry={q.refetch} /> : !q.data ? <ListSkeleton rows={3} /> : !q.data.length ? (
          <EmptyState title="No site logs yet" description="Log the day's work, workers and issues from site." />
        ) : (
          <ol className="space-y-3">
            {q.data.map((l) => (
              <li key={l.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{formatCalendarDate(l.log_date)}</span>
                  <span className="text-muted-foreground">· {l.author?.display_name ?? "—"}</span>
                  {l.workers != null ? <span className="inline-flex items-center gap-1 text-muted-foreground"><Users className="size-3.5" />{l.workers}</span> : null}
                  <span className="flex-1" />
                  {l.created_by === me.id || detail.can.manage ? <Button variant="ghost" size="sm" onClick={() => setEditing({ log: l })}>Edit</Button> : null}
                </div>
                <RichTextView value={l.work_done as RichDoc | null} className="mt-1" />
                {l.issues ? <p className="mt-1 text-sm text-amber-200">Issue: {l.issues}</p> : null}
              </li>
            ))}
          </ol>
        )}
        {q.data && q.data.length >= limit ? <div className="pt-3 text-center"><Button variant="ghost" size="sm" onClick={() => setLimit((n) => Math.min(n + 14, 100))}>Show older days</Button></div> : null}
      </CardContent>
      <SiteLogDialog projectId={projectId} log={editing?.log ?? null} open={!!editing} onOpenChange={(o) => !o && setEditing(null)} onDone={q.refetch} />
    </Card>
  );
}

function SiteLogDialog({ projectId, log, open, onOpenChange, onDone }: { projectId: string; log: SiteLog | null; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [f, setF] = useState({ logDate: istToday(), workDone: null as RichDoc | null, workers: "", issues: "" });
  const [pending, start] = useTransition();
  const [was, setWas] = useState<string | null>(null);
  const k = open ? (log?.id ?? "new") : null;
  if (k !== was) {
    setWas(k);
    if (open) setF({ logDate: log?.log_date ?? istToday(), workDone: (log?.work_done as RichDoc | null) ?? null, workers: log?.workers != null ? String(log.workers) : "", issues: log?.issues ?? "" });
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{log ? `Site log · ${formatCalendarDate(log.log_date)}` : "Today's site log"}</DialogTitle><DialogDescription>Photos go in the project&apos;s “Execution photos” folder.</DialogDescription></DialogHeader>
        <FieldGroup className="gap-4">
          {!log ? <Field><FieldLabel htmlFor="log-date">Day</FieldLabel><DateField id="log-date" value={f.logDate} onChange={(v) => setF({ ...f, logDate: v })} /></Field> : null}
          <Field><FieldLabel>Work done</FieldLabel><RichTextEditor key={k ?? "x"} value={f.workDone} onChange={(d) => setF((x) => ({ ...x, workDone: d }))} placeholder="Laid 120 sq ft granite near the porch, started drip line…" /></Field>
          <div className="grid grid-cols-[120px_1fr] gap-3">
            <Field><FieldLabel htmlFor="log-workers">Workers</FieldLabel><Input id="log-workers" inputMode="numeric" value={f.workers} onChange={(e) => setF({ ...f, workers: e.target.value.replace(/\D/g, "") })} /></Field>
            <Field><FieldLabel htmlFor="log-issues">Issues</FieldLabel><Input id="log-issues" maxLength={2000} value={f.issues} placeholder="Material short, rain, client change…" onChange={(e) => setF({ ...f, issues: e.target.value })} /></Field>
          </div>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button disabled={pending || (!f.workDone && !f.issues.trim())} onClick={() => start(async () => {
            const r = await saveSiteLog({ projectId, id: log?.id, version: log?.version, logDate: f.logDate, workDone: f.workDone, workers: f.workers ? Number(f.workers) : null, issues: f.issues });
            if (!r.ok) return void toast.error(r.error);
            toast.success("Site log saved");
            onOpenChange(false);
            onDone();
          })}>{pending && <Loader2 className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SNAG_COLOR = { open: "orange", fixed: "sky", verified: "emerald" } as const;

/** Handover snag list: what still has to be fixed, who fixes it, and the manager's check. */
export function SnagsCard({ detail }: { detail: ProjectDetail }) {
  const me = useProfile();
  const projectId = detail.project.id;
  const q = useLiveQuery({ queryKey: `snags:${me.id}:${projectId}`, fetcher: (s) => fetchSnags(projectId, s), tables: ["project_snags"] });
  const [f, setF] = useState({ title: "", ownerId: "" });
  const [pending, start] = useTransition();
  const people = [...new Map(detail.members.map((m) => [m.id, m])).values()];
  const open = q.data?.filter((s) => s.status === "open").length ?? 0;
  const set = (s: Snag, status: Snag["status"]) => start(async () => {
    const r = await setSnagStatus({ id: s.id, version: s.version, status });
    if (!r.ok) return void toast.error(r.error);
    q.refetch();
  });
  return (
    <Card className="gap-0">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Snag list</CardTitle>
        {q.data ? <span className={cn("text-sm", open ? "text-amber-300" : "text-emerald-300")}>{open ? `${open} open` : "All fixed"}</span> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await saveSnag({ projectId, title: f.title, ownerId: f.ownerId || null, dueDate: null });
            if (!r.ok) return void toast.error(r.error);
            setF({ title: "", ownerId: f.ownerId });
            q.refetch();
          });
        }}>
          <Input value={f.title} maxLength={200} placeholder="Something to fix, e.g. Drip line leaking near the gate" onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="New snag" />
          <Select value={f.ownerId || "__none"} onValueChange={(v) => setF({ ...f, ownerId: v === "__none" ? "" : v })}>
            <SelectTrigger className="sm:w-44" aria-label="Who fixes it"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="__none">Anyone</SelectItem>{people.map((p) => <SelectItem key={p.id} value={p.id}>{p.display_name}</SelectItem>)}</SelectContent>
          </Select>
          <Button type="submit" disabled={pending || !f.title.trim()}><Plus /> Add</Button>
        </form>
        {q.error && !q.data ? <ErrorState message={q.error} onRetry={q.refetch} /> : !q.data ? <ListSkeleton rows={3} /> : !q.data.length ? (
          <p className="text-sm text-muted-foreground">No snags. Add anything the client or the inspection finds before handover.</p>
        ) : (
          <ul className="divide-y">
            {q.data.map((s) => (
              <li key={s.id} className="flex items-start gap-3 py-2.5">
                <Checkbox className="mt-0.5" checked={s.status !== "open"} disabled={pending} aria-label={`Mark "${s.title}" ${s.status === "open" ? "fixed" : "open"}`}
                  onCheckedChange={(v) => set(s, v === true ? "fixed" : "open")} />
                <div className="min-w-0 flex-1">
                  <div className={cn("text-sm", s.status !== "open" && "text-muted-foreground line-through")}>{s.title}</div>
                  <div className="text-xs text-muted-foreground">{s.owner?.display_name ?? "Anyone"} · added {formatRelative(s.created_at)}{s.fixed_at ? ` · fixed ${formatRelative(s.fixed_at)}` : ""}</div>
                </div>
                <Badge variant="outline" className={STAGE_BADGE[SNAG_COLOR[s.status]]}>{SNAG_STATUS_LABELS[s.status]}</Badge>
                {detail.can.manage && s.status === "fixed" ? <Button size="sm" variant="outline" disabled={pending} onClick={() => set(s, "verified")}><CheckCheck /> Check</Button> : null}
                {detail.can.manage && s.status === "verified" ? <Button size="icon-sm" variant="ghost" aria-label="Reopen" disabled={pending} onClick={() => set(s, "open")}><RotateCcw /></Button> : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
