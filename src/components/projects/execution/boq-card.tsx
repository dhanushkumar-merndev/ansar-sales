"use client";

import { Fragment, useState, useTransition } from "react";
import { ChevronDown, ChevronRight, Copy, GitCompare, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLiveQuery } from "@/hooks/use-live-query";
import { formatINR } from "@/lib/format";
import { fetchBoq } from "@/lib/project-queries";
import { BOQ_SECTIONS, BOQ_STATUS_LABELS, BOQ_UNITS, type BoqItem, type BoqRevision, type BoqStatus, type ProjectDetail } from "@/lib/projects";
import { STAGE_BADGE } from "@/lib/stages";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { archiveBoqItem, archiveBoqRevision, createBoqRevision, saveBoqItem, setBoqExecuted, setBoqStatus } from "@/server/actions/execution";

const STATUS_COLOR: Record<BoqStatus, keyof typeof STAGE_BADGE> = { draft: "slate", sent: "sky", client_approved: "emerald", superseded: "slate" };
const key = (i: Pick<BoqItem, "section" | "item">) => `${i.section.toLowerCase()}|${i.item.toLowerCase()}`;

/** BOQ revisions R0…R4 as an editable sheet with section subtotals, revision compare and execution progress. */
export function BoqCard({ detail }: { detail: ProjectDetail }) {
  const me = useProfile();
  const projectId = detail.project.id;
  const myRoles = detail.members.filter((m) => m.id === me.id).map((m) => m.role);
  const manage = detail.can.manage;
  const editor = manage || myRoles.includes("landscape_designer");
  const progress = manage || myRoles.includes("execution");
  const q = useLiveQuery({ queryKey: `boq:${me.id}:${projectId}`, fetcher: (s) => fetchBoq(projectId, s), tables: ["project_boq_revisions", "project_boq_items"] });
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  const [creating, setCreating] = useState(false);
  const [find, setFind] = useState("");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();

  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.refetch} />;
  if (!q.data) return <ListSkeleton rows={4} />;
  const revisions = q.data;
  const current = revisions.find((r) => r.id === selected) ?? revisions.find((r) => r.status === "client_approved") ?? revisions.at(-1) ?? null;
  const index = current ? revisions.indexOf(current) : -1;
  const previous = index > 0 ? revisions[index - 1] : null;
  const prevByKey = new Map((previous?.items ?? []).map((i) => [key(i), i]));
  const editable = editor && current?.status === "draft";
  const sections = [...new Set((current?.items ?? []).map((i) => i.section))];
  // Long BOQs: the list scrolls inside the card (header and total stay put), can be searched and sections fold.
  const needle = find.trim().toLowerCase();
  const matches = (i: BoqItem) => !needle || `${i.item} ${i.description ?? ""} ${i.unit}`.toLowerCase().includes(needle);
  const long = (current?.items.length ?? 0) > 12;
  const toggle = (section: string) => setFolded((f) => { const n = new Set(f); if (n.has(section)) n.delete(section); else n.add(section); return n; });

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) => start(async () => {
    const r = await fn();
    if (!r.ok) return void toast.error(r.error ?? "Could not save");
    if (done) toast.success(done);
    q.refetch();
  });

  return (
    <Card className="gap-0">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-3">
        <CardTitle className="text-base">BOQ</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {revisions.map((r) => (
            <button key={r.id} type="button" onClick={() => setSelected(r.id)} aria-pressed={r.id === current?.id}
              className={cn("rounded-full border px-3 py-1 text-sm", r.id === current?.id ? "border-foreground/40 bg-accent font-medium" : "text-muted-foreground hover:text-foreground",
                r.status === "superseded" && "line-through decoration-1")}>
              {r.label}{r.status === "client_approved" ? " ✓" : ""}
            </button>
          ))}
          {editor ? <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus /> New revision</Button> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!current ? <EmptyState title="No BOQ yet" description={editor ? "Start R0 from the first-cut estimate." : undefined} /> : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={STAGE_BADGE[STATUS_COLOR[current.status]]}>{BOQ_STATUS_LABELS[current.status]}</Badge>
              <span className="text-sm text-muted-foreground">
                {current.title ? `${current.title} · ` : ""}by {current.created_by ?? "—"} · {formatDate(current.created_at)}
                {current.approved_at ? ` · approved ${formatDate(current.approved_at)}` : current.sent_at ? ` · sent ${formatDate(current.sent_at)}` : ""}
              </span>
              <span className="flex-1" />
              <span className="font-semibold tabular-nums">{formatINR(current.total)}</span>
              {previous ? <Button size="sm" variant={compare ? "secondary" : "ghost"} onClick={() => setCompare((c) => !c)}><GitCompare /> Compare with {previous.label}</Button> : null}
              {manage && current.status !== "superseded" ? (
                <Select value={current.status} onValueChange={(v) => act(() => setBoqStatus({ id: current.id, version: current.version, status: v as "draft" | "sent" | "client_approved" }), "BOQ status updated")}>
                  <SelectTrigger size="sm" className="w-44" aria-label="BOQ status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft</SelectItem><SelectItem value="sent">Sent to client</SelectItem><SelectItem value="client_approved">Client approved</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              {editable ? (
                <ConfirmDialog trigger={<Button size="icon-sm" variant="ghost" aria-label="Remove draft"><Trash2 /></Button>}
                  title={`Remove draft ${current.label}?`} description="Its items are removed with it." confirmLabel="Remove" destructive
                  onConfirm={async () => { const r = await archiveBoqRevision({ id: current.id }); if (!r.ok) { toast.error(r.error); return false; } setSelected(null); q.refetch(); }} />
              ) : null}
            </div>
            {compare && previous ? (
              <p className="text-sm text-muted-foreground">
                {previous.label} total {formatINR(previous.total)} → {current.label} {formatINR(current.total)}
                <span className={cn("ml-1 font-medium", current.total >= previous.total ? "text-amber-300" : "text-emerald-300")}>
                  ({current.total >= previous.total ? "+" : "−"}{formatINR(Math.abs(current.total - previous.total))})
                </span>
              </p>
            ) : null}
            {long ? (
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input type="search" className="h-8 w-64 pl-8" placeholder={`Find in ${current.items.length} items`} value={find} maxLength={100}
                    onChange={(e) => setFind(e.target.value)} aria-label="Find a BOQ item" />
                </div>
                {sections.length > 1 ? (
                  <Button size="sm" variant="ghost" onClick={() => setFolded(folded.size ? new Set() : new Set(sections))}>
                    {folded.size ? <><ChevronDown /> Expand all</> : <><ChevronRight /> Collapse all</>}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="rounded-lg border [&>[data-slot=table-container]]:max-h-[min(70dvh,760px)] [&>[data-slot=table-container]]:overflow-auto">
              <Table className="min-w-[860px]">
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="bg-amber-300/10 hover:bg-amber-300/10">
                    <TableHead className="w-10">#</TableHead><TableHead>Item</TableHead><TableHead className="w-24">Unit</TableHead>
                    <TableHead className="w-28 text-right">Qty</TableHead><TableHead className="w-32 text-right">Rate (₹)</TableHead>
                    <TableHead className="w-36 text-right">Amount</TableHead><TableHead className="w-44">Executed</TableHead><TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sections.map((section) => {
                    const all = current.items.filter((i) => i.section === section);
                    const subtotal = all.reduce((s, i) => s + Number(i.amount), 0);
                    const shown = all.filter(matches);
                    if (needle && !shown.length) return null;
                    const closed = folded.has(section) && !needle;
                    return (
                      <Fragment key={section}>
                        <TableRow className="cursor-pointer bg-muted/40 hover:bg-muted/60" onClick={() => toggle(section)}>
                          <TableCell colSpan={5} className="text-xs font-semibold uppercase tracking-wide">
                            <button type="button" className="inline-flex items-center gap-1 uppercase" aria-expanded={!closed} onClick={(e) => { e.stopPropagation(); toggle(section); }}>
                              {closed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}{section}
                              <span className="font-normal normal-case text-muted-foreground">· {needle ? `${shown.length} of ${all.length}` : all.length} item{all.length === 1 ? "" : "s"}</span>
                            </button>
                          </TableCell>
                          <TableCell className="text-right text-sm font-semibold tabular-nums">{formatINR(subtotal)}</TableCell>
                          <TableCell colSpan={2} />
                        </TableRow>
                        {closed ? null : shown.map((it) => (
                          <ItemRow key={it.id} n={all.indexOf(it) + 1} item={it} prev={compare ? prevByKey.get(key(it)) ?? null : undefined} editable={editable} progress={progress && current.status !== "draft"}
                            onSave={(patch) => act(() => saveBoqItem({ revisionId: current.id, id: it.id, section: it.section, item: it.item, description: it.description ?? "", unit: it.unit, qty: it.qty, rate: it.rate, ...patch }))}
                            onExecuted={(v) => act(() => setBoqExecuted({ id: it.id, executedQty: v }))}
                            onRemove={() => act(() => archiveBoqItem({ id: it.id }))} />
                        ))}
                      </Fragment>
                    );
                  })}
                  {compare && previous ? previous.items.filter((p) => !current.items.some((i) => key(i) === key(p))).map((p) => (
                    <TableRow key={`gone-${p.id}`} className="text-muted-foreground line-through">
                      <TableCell /><TableCell>{p.item} <span className="text-xs">({p.section}, removed)</span></TableCell><TableCell>{p.unit}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(p.qty)}</TableCell><TableCell className="text-right tabular-nums">{formatINR(p.rate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatINR(p.amount)}</TableCell><TableCell colSpan={2} />
                    </TableRow>
                  )) : null}
                </TableBody>
                <TableFooter className="sticky bottom-0 z-10 bg-card">
                  <TableRow><TableCell colSpan={5} className="font-semibold">Total</TableCell><TableCell className="text-right font-semibold tabular-nums">{formatINR(current.total)}</TableCell><TableCell colSpan={2} /></TableRow>
                </TableFooter>
              </Table>
            </div>
            {needle && !current.items.some(matches) ? <p className="text-sm text-muted-foreground">No item matches “{find.trim()}”.</p> : null}
            {editable ? <AddItemRow revisionId={current.id} sections={[...new Set([...BOQ_SECTIONS, ...sections])]} onAdded={q.refetch} /> : null}
          </>
        )}
      </CardContent>
      <NewRevisionDialog projectId={projectId} revisions={revisions} from={current} open={creating} onOpenChange={setCreating}
        onDone={(id) => { setSelected(id); q.refetch(); }} pending={pending} />
    </Card>
  );
}

function ItemRow({ n, item, prev, editable, progress, onSave, onExecuted, onRemove }: {
  n: number; item: BoqItem; prev?: BoqItem | null; editable: boolean; progress: boolean;
  onSave: (patch: Partial<{ item: string; unit: string; qty: number; rate: number }>) => void; onExecuted: (v: number) => void; onRemove: () => void;
}) {
  const pct = Number(item.qty) ? Math.min(100, Math.round((Number(item.executed_qty) / Number(item.qty)) * 100)) : 0;
  const changed = (a: number, b: number | undefined) => prev && b !== undefined && Number(a) !== Number(b);
  return (
    <TableRow className={cn(prev === null && "bg-emerald-400/[0.06]")}>
      <TableCell className="tabular-nums text-muted-foreground">{n}</TableCell>
      <TableCell>
        {editable ? <CellInput value={item.item} onCommit={(v) => v.trim() && v !== item.item && onSave({ item: v })} aria-label="Item" />
          : <span>{item.item}</span>}
        {prev === null ? <Badge variant="outline" className={cn("ml-2", STAGE_BADGE.emerald)}>New</Badge> : null}
        {item.description ? <div className="text-xs text-muted-foreground">{item.description}</div> : null}
      </TableCell>
      <TableCell>{editable ? (
        <Select value={item.unit} onValueChange={(v) => onSave({ unit: v })}>
          <SelectTrigger size="sm" className="w-20" aria-label="Unit"><SelectValue /></SelectTrigger>
          <SelectContent>{[...new Set([...BOQ_UNITS, item.unit])].map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
        </Select>
      ) : item.unit}</TableCell>
      <TableCell className={cn("text-right tabular-nums", changed(item.qty, prev?.qty) && "text-amber-300")}>
        {editable ? <CellInput numeric value={String(Number(item.qty))} onCommit={(v) => Number(v) !== Number(item.qty) && onSave({ qty: Number(v) })} aria-label="Quantity" /> : Number(item.qty)}
        {changed(item.qty, prev?.qty) ? <div className="text-[11px] text-muted-foreground">was {Number(prev!.qty)}</div> : null}
      </TableCell>
      <TableCell className={cn("text-right tabular-nums", changed(item.rate, prev?.rate) && "text-amber-300")}>
        {editable ? <CellInput numeric value={String(Number(item.rate))} onCommit={(v) => Number(v) !== Number(item.rate) && onSave({ rate: Number(v) })} aria-label="Rate" /> : formatINR(item.rate)}
        {changed(item.rate, prev?.rate) ? <div className="text-[11px] text-muted-foreground">was {formatINR(prev!.rate)}</div> : null}
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums">{formatINR(item.amount)}</TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {progress ? <CellInput numeric className="w-16" value={String(Number(item.executed_qty))} onCommit={(v) => Number(v) !== Number(item.executed_qty) && onExecuted(Number(v))} aria-label="Executed quantity" />
            : <span className="text-sm tabular-nums">{Number(item.executed_qty)}</span>}
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-400" style={{ width: `${pct}%` }} /></div>
          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
        </div>
      </TableCell>
      <TableCell>{editable ? <Button variant="ghost" size="icon-sm" aria-label={`Remove ${item.item}`} onClick={onRemove}><X /></Button> : null}</TableCell>
    </TableRow>
  );
}

/** Spreadsheet-like cell: edits locally, saves on Enter or when leaving the cell; Escape undoes. */
function CellInput({ value, onCommit, numeric, className, ...rest }: { value: string; onCommit: (v: string) => void; numeric?: boolean; className?: string; "aria-label": string }) {
  const [v, setV] = useState(value);
  const [base, setBase] = useState(value);
  if (value !== base) { setBase(value); setV(value); }
  return (
    <Input {...rest} value={v} inputMode={numeric ? "decimal" : undefined}
      className={cn("h-8 border-transparent bg-transparent px-1.5 hover:border-border focus-visible:border-border", numeric && "text-right tabular-nums", className)}
      onChange={(e) => setV(numeric ? e.target.value.replace(/[^\d.]/g, "") : e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setV(value); (e.target as HTMLInputElement).blur(); } }}
      onBlur={() => { if (v !== value) onCommit(v); }} />
  );
}

function AddItemRow({ revisionId, sections, onAdded }: { revisionId: string; sections: string[]; onAdded: () => void }) {
  const [f, setF] = useState({ section: sections[0] ?? "Hardscape", item: "", unit: "sqft", qty: "", rate: "" });
  const [pending, start] = useTransition();
  return (
    <form className="grid gap-2 rounded-lg border border-dashed p-2 sm:grid-cols-[140px_1fr_90px_90px_110px_auto]" onSubmit={(e) => {
      e.preventDefault();
      start(async () => {
        const r = await saveBoqItem({ revisionId, ...f, qty: f.qty || 0, rate: f.rate || 0 });
        if (!r.ok) return void toast.error(r.error);
        setF((x) => ({ ...x, item: "", qty: "", rate: "" }));
        onAdded();
      });
    }}>
      <Select value={f.section} onValueChange={(v) => setF({ ...f, section: v })}>
        <SelectTrigger className="w-full" aria-label="Section"><SelectValue /></SelectTrigger>
        <SelectContent>{sections.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
      </Select>
      <Input value={f.item} maxLength={200} placeholder="New item, e.g. Granite paving" onChange={(e) => setF({ ...f, item: e.target.value })} aria-label="New item" />
      <Select value={f.unit} onValueChange={(v) => setF({ ...f, unit: v })}>
        <SelectTrigger className="w-full" aria-label="Unit"><SelectValue /></SelectTrigger>
        <SelectContent>{BOQ_UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
      </Select>
      <Input inputMode="decimal" placeholder="Qty" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} aria-label="Quantity" />
      <Input inputMode="decimal" placeholder="Rate ₹" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} aria-label="Rate" />
      <Button type="submit" disabled={pending || !f.item.trim()}>{pending ? <Loader2 className="animate-spin" /> : <Plus />}Add</Button>
    </form>
  );
}

function NewRevisionDialog({ projectId, revisions, from, open, onOpenChange, onDone, pending: outer }: {
  projectId: string; revisions: BoqRevision[]; from: BoqRevision | null; open: boolean; onOpenChange: (o: boolean) => void; onDone: (id: string) => void; pending: boolean;
}) {
  const next = `R${revisions.length}`;
  const [label, setLabel] = useState(next);
  const [title, setTitle] = useState("");
  const [copy, setCopy] = useState(true);
  const [pending, start] = useTransition();
  const [was, setWas] = useState(false);
  if (open !== was) { setWas(open); if (open) { setLabel(next); setTitle(""); setCopy(Boolean(from)); } }
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>New BOQ revision</DialogTitle><DialogDescription>A draft the team can edit until it is sent to the client.</DialogDescription></DialogHeader>
        <FieldGroup className="gap-3">
          <Field><FieldLabel htmlFor="boq-label">Label</FieldLabel><Input id="boq-label" value={label} maxLength={20} onChange={(e) => setLabel(e.target.value)} /></Field>
          <Field><FieldLabel htmlFor="boq-title">Title (optional)</FieldLabel><Input id="boq-title" value={title} maxLength={120} placeholder="e.g. Hardscape + softscape" onChange={(e) => setTitle(e.target.value)} /></Field>
          {from ? (
            <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-current" checked={copy} onChange={(e) => setCopy(e.target.checked)} /><Copy className="size-4" />Copy items from {from.label}</label>
          ) : null}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button disabled={pending || outer || !label.trim()} onClick={() => start(async () => {
            const r = await createBoqRevision({ projectId, label, title, copyFrom: copy && from ? from.id : undefined });
            if (!r.ok) return void toast.error(r.error);
            toast.success(`${label.toUpperCase()} created`);
            onOpenChange(false);
            onDone(r.data.id);
          })}>{pending && <Loader2 className="animate-spin" />}Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
