"use client";

import { useState, useTransition } from "react";
import { Check, Download, Eye, Loader2, LogOut, MessageSquare, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { BrandMark, BrandName } from "@/components/app/brand";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/common/states";
import { MilestoneBadge } from "@/components/projects/payments/milestone-badge";
import { FileKindIcon } from "@/components/projects/files/file-badges";
import { PhaseStatusBadge } from "@/components/projects/project-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { companyLogoUrl } from "@/lib/companies";
import { formatINR } from "@/lib/format";
import { formatBytes, MEMBER_ROLE_LABELS, type FileKind, type FileVersionStatus, type Milestone, type PhaseStatus, type ProjectMemberRole } from "@/lib/projects";
import { signOutAndReload } from "@/lib/sign-out";
import { STAGE_BADGE, STAGE_HEX, type StageColor } from "@/lib/stages";
import { createClient } from "@/lib/supabase/client";
import { formatCalendarDate, formatRelative } from "@/lib/time";
import { portalDecision, portalFileUrl } from "@/server/actions/project-portal";

type PortalFile = {
  id: string; name: string; kind: FileKind; folder: string; folder_key: string | null; version_id: string; version_no: number;
  status: FileVersionStatus; size_bytes: number; mime_type: string; client_comment: string | null; updated_at: string;
};
type PortalProject = {
  id: string; code: string; name: string; site_address: string | null; start_date: string; end_date: string; status: string; color: StageColor;
  team: { name: string; role: ProjectMemberRole }[];
  phases: { id: string; category: string; name: string; color: StageColor; planned_start: string; deadline: string; submitted_on: string | null;
    status: PhaseStatus; needs_client_approval: boolean; items: { title: string; done: boolean }[] }[];
  files: PortalFile[];
  payments: { contract_value: number | null; received: number; milestones: Milestone[] };
};
type Portal = { company: { name: string; brand_highlight: string | null; logo_path: string | null }; me: string; projects: PortalProject[] };

const PHOTO_FOLDERS = new Set(["site_images", "execution_photos"]);

/** The client's own project: process timeline, approved drawings to review, photos and payments. */
export function ProjectPortalView() {
  const q = useLiveQuery({
    queryKey: "project-portal",
    fetcher: async (signal) => {
      const { data, error } = await createClient().rpc("my_project_portal").abortSignal(signal);
      if (error) throw error;
      return data as unknown as Portal;
    },
    pollMs: 5 * 60_000,
  });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [leaving, startLeaving] = useTransition();
  const p = q.data;
  const project = p?.projects.find((x) => x.id === projectId) ?? p?.projects[0];

  return (
    <div className="min-h-svh bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
          <BrandMark size={32} logoUrl={companyLogoUrl(p?.company.logo_path)} />
          <div className="min-w-0 flex-1 leading-tight">
            {p ? <BrandName name={p.company.name} highlight={p.company.brand_highlight} className="text-sm font-semibold" /> : <span className="text-sm">&nbsp;</span>}
            <p className="truncate text-xs text-muted-foreground">Welcome{p?.me ? `, ${p.me}` : ""}</p>
          </div>
          <Button variant="ghost" size="sm" disabled={leaving} onClick={() => startLeaving(() => signOutAndReload())}>{leaving ? <Loader2 className="animate-spin" /> : <LogOut />} Sign out</Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        {q.error && !p ? <ErrorState message={q.error} onRetry={q.refetch} /> : !p ? <ListSkeleton rows={6} /> : !project ? <EmptyState title="No project yet" /> : (
          <>
            {p.projects.length > 1 ? (
              <div className="flex flex-wrap gap-2">
                {p.projects.map((x) => <Button key={x.id} size="sm" variant={x.id === project.id ? "secondary" : "outline"} onClick={() => setProjectId(x.id)}>{x.name}</Button>)}
              </div>
            ) : null}
            <ProjectPortal project={project} onChanged={q.refetch} />
          </>
        )}
      </main>
    </div>
  );
}

function ProjectPortal({ project: pr, onChanged }: { project: PortalProject; onChanged: () => void }) {
  const done = pr.phases.filter((x) => x.status === "done").length;
  const pct = pr.phases.length ? Math.round((done / pr.phases.length) * 100) : 0;
  const docs = pr.files.filter((f) => !(PHOTO_FOLDERS.has(f.folder_key ?? "") && f.kind === "image"));
  const photos = pr.files.filter((f) => PHOTO_FOLDERS.has(f.folder_key ?? "") && f.kind === "image");
  const waiting = docs.filter((f) => f.status === "approved").length;
  return (
    <>
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{pr.name}</h1>
        <p className="text-sm text-muted-foreground">{pr.code}{pr.site_address ? ` · ${pr.site_address}` : ""} · {formatCalendarDate(pr.start_date)} – {formatCalendarDate(pr.end_date)}</p>
        <div className="flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-emerald-400" style={{ width: `${pct}%` }} /></div>
          <span className="text-sm tabular-nums">{pct}% done</span>
        </div>
        {pr.team.length ? <p className="text-sm text-muted-foreground">Your team: {pr.team.map((t) => `${t.name} (${MEMBER_ROLE_LABELS[t.role]})`).join(", ")}</p> : null}
      </section>

      {waiting ? (
        <div className="rounded-xl border border-sky-400/40 bg-sky-400/10 px-4 py-3 text-sm">
          {waiting} file{waiting === 1 ? " is" : "s are"} waiting for your review below.
        </div>
      ) : null}

      <Card className="gap-0">
        <CardHeader className="pb-3"><CardTitle className="text-base">Project process</CardTitle></CardHeader>
        <CardContent>
          <ol className="space-y-2.5">
            {pr.phases.map((ph, i) => {
              const hex = STAGE_HEX[ph.color] ?? STAGE_HEX.slate;
              return (
                <li key={ph.id} className="flex items-stretch overflow-hidden rounded-xl border">
                  <div className="flex w-14 shrink-0 items-center justify-center text-xl font-semibold" style={{ background: `${hex}22`, color: hex }}>{String(i + 1).padStart(2, "0")}</div>
                  <div className="min-w-0 flex-1 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{ph.name}</span><span className="text-xs uppercase tracking-wide text-muted-foreground">{ph.category}</span></div>
                    <div className="text-xs text-muted-foreground">Planned {formatCalendarDate(ph.planned_start)} – {formatCalendarDate(ph.deadline)}{ph.needs_client_approval ? " · needs your approval" : ""}</div>
                    {ph.items.length ? <div className="mt-1 text-xs text-muted-foreground">{ph.items.map((it) => `${it.done ? "✓" : "•"} ${it.title}`).join("   ")}</div> : null}
                  </div>
                  <div className="flex items-center px-3"><PhaseStatusBadge status={ph.status} /></div>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      <Card className="gap-0">
        <CardHeader className="pb-3"><CardTitle className="text-base">Drawings and documents</CardTitle></CardHeader>
        <CardContent>
          {!docs.length ? <p className="text-sm text-muted-foreground">Your team will share drawings, decks and BOQs here once they&apos;re ready.</p> : (
            <ul className="divide-y">{docs.map((f) => <PortalFileRow key={f.id} file={f} onChanged={onChanged} />)}</ul>
          )}
        </CardContent>
      </Card>

      {photos.length ? (
        <Card className="gap-0">
          <CardHeader className="pb-3"><CardTitle className="text-base">Site photos</CardTitle></CardHeader>
          <CardContent><ul className="divide-y">{photos.map((f) => <PortalFileRow key={f.id} file={f} onChanged={onChanged} photo />)}</ul></CardContent>
        </Card>
      ) : null}

      {pr.payments.milestones.length ? (
        <Card className="gap-0">
          <CardHeader className="pb-3"><CardTitle className="text-base">Payment schedule</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {pr.payments.contract_value != null ? (
              <p className="text-sm text-muted-foreground">Project value {formatINR(pr.payments.contract_value)} · paid {formatINR(pr.payments.received)}</p>
            ) : null}
            <ul className="divide-y">
              {pr.payments.milestones.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 py-2.5">
                  <span className="font-medium">{m.label}</span>
                  {m.percent != null ? <span className="text-sm text-muted-foreground">{Number(m.percent)}%</span> : null}
                  <MilestoneBadge status={m.status} />
                  <span className="flex-1" />
                  <span className="text-sm tabular-nums">{m.amount != null ? formatINR(m.amount) : ""}{m.balance ? <span className="text-muted-foreground"> · {formatINR(m.balance)} left</span> : null}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function PortalFileRow({ file: f, onChanged, photo }: { file: PortalFile; onChanged: () => void; photo?: boolean }) {
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  const open = (download: boolean) => start(async () => {
    const r = await portalFileUrl({ versionId: f.version_id, download });
    if (!r.ok) return void toast.error(r.error);
    window.open(r.data.url, "_blank", "noopener,noreferrer");
    onChanged();
  });
  const decide = (approve: boolean) => start(async () => {
    const r = await portalDecision({ versionId: f.version_id, approve, comment: approve ? undefined : comment });
    if (!r.ok) return void toast.error(r.error);
    toast.success(approve ? "Thank you — approved" : "Sent to your team");
    setAsking(false);
    setComment("");
    onChanged();
  });
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <FileKindIcon kind={f.kind} className="size-5" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{f.name}</div>
        <div className="text-xs text-muted-foreground">{f.folder} · version {f.version_no} · {formatBytes(f.size_bytes)} · {formatRelative(f.updated_at)}</div>
        {f.client_comment ? <div className="text-xs text-amber-200">You asked: “{f.client_comment}”</div> : null}
      </div>
      {!photo ? (
        f.status === "client_approved" ? <Badge variant="outline" className={STAGE_BADGE.emerald}><Check className="size-3" /> You approved</Badge>
          : f.status === "changes_requested" ? <Badge variant="outline" className={STAGE_BADGE.orange}>Changes asked</Badge>
          : <Badge variant="outline" className={STAGE_BADGE.sky}>Please review</Badge>
      ) : null}
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" disabled={pending} onClick={() => open(false)}><Eye /> View</Button>
        <Button size="icon-sm" variant="ghost" disabled={pending} aria-label={`Download ${f.name}`} onClick={() => open(true)}><Download /></Button>
        {!photo && f.status === "approved" ? (
          <>
            <Button size="sm" disabled={pending} className="bg-emerald-600 text-white hover:bg-emerald-500" onClick={() => decide(true)}><ThumbsUp /> Approve</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setAsking(true)}><MessageSquare /> Changes</Button>
          </>
        ) : null}
      </div>
      <Dialog open={asking} onOpenChange={(o) => !pending && setAsking(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>What should change?</DialogTitle><DialogDescription>{f.name} · version {f.version_no}. Your team is told right away.</DialogDescription></DialogHeader>
          <Textarea rows={4} value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} placeholder="e.g. Please add more shade trees near the gate" aria-label="Your comments" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(false)} disabled={pending}>Cancel</Button>
            <Button disabled={pending || !comment.trim()} onClick={() => decide(false)}>{pending && <Loader2 className="animate-spin" />}Send</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
