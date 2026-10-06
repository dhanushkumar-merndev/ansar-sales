"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, ArrowLeft, CalendarPlus, Check, Loader2, Mail, MoreHorizontal, Pencil, Phone, Send, UserRoundCog, X } from "lucide-react";
import { toast } from "sonner";
import { DueBadge, ReminderBadge, StatusBadge } from "@/components/common/badges";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { StarButton } from "@/components/common/star-pin-buttons";
import { EmptyState, ErrorState, FetchingIndicator, ListSkeleton } from "@/components/common/states";
import { CompleteFollowUpDialog, FollowUpDialog } from "@/components/follow-ups/follow-up-dialogs";
import { CallButton } from "@/components/leads/call-button";
import { LeadFormDialog } from "@/components/leads/lead-form-dialog";
import { ShareFilesDialog } from "@/components/leads/share-files-dialog";
import { ScrollBox } from "@/components/common/scroll-box";
import { SharedLinksCard } from "@/components/leads/shared-links-card";
import { StaffSelect } from "@/components/leads/staff-select";
import { Timeline } from "@/components/leads/timeline";
import { useProfile } from "@/components/providers/profile-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { LEAD_STATUSES, STATUS_LABELS, type LeadStatus } from "@/lib/constants";
import { fetchLead, fetchLeadFollowUps, fetchTimeline, type Activity, type LeadFollowUp } from "@/lib/queries";
import { formatDate, formatDateTime, formatRelative } from "@/lib/time";
import type { NicheOption } from "@/lib/types";
import { cn } from "@/lib/utils";
import { cancelFollowUp } from "@/server/actions/follow-ups";
import { addNote, assignLead, correctNote, setLeadArchived, setLeadStatus } from "@/server/actions/leads";
import { toggleLeadStar } from "@/server/actions/stars";

const TIMELINE_PAGE = 20;
const TIMELINE_MAX = 500;

export function LeadDetailView({ leadId, initialNiches }: { leadId: string; initialNiches: NicheOption[] }) {
  const profile = useProfile();
  const isAdmin = profile.role === "admin";
  const [timelineLimit, setTimelineLimit] = useState(TIMELINE_PAGE);

  const lead = useLiveQuery({ queryKey: `lead:${profile.id}:${leadId}`, fetcher: (s) => fetchLead(leadId, s), tables: ["leads", "niches", "lead_stars"] });
  const followUps = useLiveQuery({ queryKey: `lead-fu:${profile.id}:${leadId}`, fetcher: (s) => fetchLeadFollowUps(leadId, s), tables: ["follow_ups", "leads"] });
  const timeline = useLiveQuery({
    queryKey: `timeline:${profile.id}:${leadId}:${timelineLimit}`,
    fetcher: (s) => fetchTimeline(leadId, timelineLimit, s),
    tables: ["lead_activities", "leads"],
  });

  const [editOpen, setEditOpen] = useState(false);
  const [editSnapshot, setEditSnapshot] = useState<{ version: number } | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [reschedule, setReschedule] = useState<LeadFollowUp | null>(null);
  const [completing, setCompleting] = useState<LeadFollowUp | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const refreshAll = () => {
    lead.refetch();
    followUps.refetch();
    timeline.refetch();
  };

  if (lead.error && !lead.data) return <ErrorState message={lead.error} onRetry={lead.refetch} />;
  if (lead.isInitialLoading) return <DetailSkeleton />;
  const l = lead.data;
  if (!l) {
    return (
      <EmptyState
        title="Lead not available"
        description="It doesn't exist, was archived, or was reassigned so you no longer have access."
        action={<Button variant="outline" asChild><Link href="/leads"><ArrowLeft /> Back to leads</Link></Button>}
      />
    );
  }
  const archived = Boolean(l.archived_at);
  const canEdit = !archived;
  const next = followUps.data?.[0];

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" asChild className="-ml-2"><Link href="/leads"><ArrowLeft /> Leads</Link></Button>
        <FetchingIndicator show={lead.isFetching || followUps.isFetching || timeline.isFetching} />
      </div>

      {archived ? (
        <div role="status" className="mb-4 rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
          Archived {formatDate(l.archived_at!)}. Restore it to make changes.
        </div>
      ) : null}

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{l.name}</h1>
            {canEdit ? <StarButton id={l.id} starred={l.stars.length > 0} action={toggleLeadStar} onChanged={lead.refetch} /> : null}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <StatusBadge status={l.status} />
            <span>{l.niche.name}</span>
            <span aria-hidden>·</span>
            <span>Owner: <span className="text-foreground">{l.owner.display_name}</span></span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit ? <CallButton leadId={l.id} phone={l.phone_normalized} leadName={l.name} onLogged={timeline.refetch} /> : null}
          {canEdit ? <Button variant="outline" onClick={() => setShareOpen(true)}><Send /> Share files</Button> : null}
          {canEdit ? <StatusSelect leadId={l.id} status={l.status} onChanged={refreshAll} /> : null}
          {canEdit ? (
            <Button variant="outline" onClick={() => { setEditSnapshot({ version: l.version }); setEditOpen(true); }}><Pencil /> Edit</Button>
          ) : null}
          {isAdmin ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="More actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit ? <DropdownMenuItem onSelect={() => setAssignOpen(true)}><UserRoundCog /> Reassign</DropdownMenuItem> : null}
                <ArchiveMenuItem leadId={l.id} archived={archived} onDone={refreshAll} />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card className={cn(next?.due_at && new Date(next.due_at) < new Date() && "border-red-200")}>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">Upcoming follow-ups</CardTitle>
              {canEdit ? <Button size="sm" onClick={() => setScheduleOpen(true)}><CalendarPlus /> Schedule</Button> : null}
            </CardHeader>
            <CardContent>
              {followUps.isInitialLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : followUps.error && !followUps.data ? (
                <ErrorState message={followUps.error} onRetry={followUps.refetch} />
              ) : !followUps.data?.length ? (
                <p className="text-sm text-muted-foreground">No pending follow-ups.</p>
              ) : (
                <ul className="space-y-3">
                  {followUps.data.map((f, i) => {
                    const overdue = new Date(f.due_at) < new Date();
                    const reminder = f.reminder_deliveries.find((d) => d.revision === f.revision) ?? null;
                    return (
                      <li key={f.id} className={cn("rounded-md border p-3", i === 0 && "bg-accent/40", overdue && "border-red-200 bg-red-50/50")}>
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium">{f.task}</p>
                          <DueBadge overdue={overdue} />
                        </div>
                        <p className={cn("mt-0.5 text-sm", overdue ? "text-red-700" : "text-muted-foreground")}>
                          {formatDateTime(f.due_at)} · {formatRelative(f.due_at)}
                        </p>
                        <ReminderBadge reminder={reminder} />
                        {canEdit ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            <Button size="xs" onClick={() => setCompleting(f)}><Check /> Complete</Button>
                            <Button size="xs" variant="outline" onClick={() => setReschedule(f)}>Reschedule</Button>
                            <ConfirmDialog
                              trigger={<Button size="xs" variant="ghost"><X /> Cancel</Button>}
                              title="Cancel this follow-up?"
                              description="The reminder will not be sent. This is recorded in the timeline."
                              confirmLabel="Cancel follow-up"
                              destructive
                              onConfirm={async () => {
                                const r = await cancelFollowUp({ id: f.id });
                                if (!r.ok) { toast.error(r.error); return false; }
                                toast.success("Follow-up cancelled");
                                refreshAll();
                              }}
                            />
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Contact</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {canEdit ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2"><Phone className="size-4 text-muted-foreground" />{l.phone}</span>
                  <CallButton size="sm" leadId={l.id} phone={l.phone_normalized} leadName={l.name} onLogged={timeline.refetch} />
                </div>
              ) : (
                <a href={`tel:${l.phone_normalized}`} className="flex items-center gap-2 hover:underline"><Phone className="size-4 text-muted-foreground" />{l.phone}</a>
              )}
              {l.email ? <a href={`mailto:${l.email}`} className="flex items-center gap-2 break-all hover:underline"><Mail className="size-4 text-muted-foreground" />{l.email}</a> : <p className="text-muted-foreground">No email</p>}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-2 text-muted-foreground">
                <dt>Created</dt><dd className="text-foreground">{formatDateTime(l.created_at)}</dd>
                <dt>By</dt><dd className="text-foreground">{l.creator?.display_name ?? "—"}</dd>
                <dt>Updated</dt><dd className="text-foreground">{formatDateTime(l.updated_at)}</dd>
              </dl>
            </CardContent>
          </Card>

          <SharedLinksCard leadId={l.id} leadName={l.name} phone={l.phone_normalized} profileId={profile.id} canEdit={canEdit} onShare={() => setShareOpen(true)} />
        </div>

        <div className="space-y-5">
          {canEdit ? <NoteComposer leadId={l.id} onAdded={timeline.refetch} /> : null}
          <Card>
            <CardHeader><CardTitle className="text-base">Activity</CardTitle></CardHeader>
            <CardContent>
              {timeline.isInitialLoading ? (
                <ListSkeleton rows={4} />
              ) : timeline.error && !timeline.data ? (
                <ErrorState message={timeline.error} onRetry={timeline.refetch} />
              ) : (
                <ScrollBox label="Activity history" className="max-h-[min(70svh,720px)]">
                  <Timeline
                    items={timeline.data?.items ?? []}
                    renderNoteActions={(a) => (canEdit && (a.actor_id === profile.id || isAdmin) ? <CorrectNote note={a} onDone={timeline.refetch} /> : null)}
                  />
                  {timeline.data?.hasMore && timelineLimit < TIMELINE_MAX ? (
                    <Button variant="outline" size="sm" className="mt-4 w-full" disabled={timeline.isFetching} onClick={() => setTimelineLimit((n) => n + TIMELINE_PAGE)}>
                      {timeline.isFetching && <Loader2 className="animate-spin" />} Show older activity
                    </Button>
                  ) : null}
                </ScrollBox>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <LeadFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        initialNiches={initialNiches}
        lead={editOpen && editSnapshot ? { id: l.id, version: editSnapshot.version, name: l.name, phone: l.phone, email: l.email, niche: l.niche } : undefined}
        latestVersion={l.version}
        onSaved={refreshAll}
      />
      <FollowUpDialog open={scheduleOpen} onOpenChange={setScheduleOpen} leadId={l.id} onDone={refreshAll} />
      <FollowUpDialog open={!!reschedule} onOpenChange={(o) => !o && setReschedule(null)} followUp={reschedule ?? undefined} onDone={refreshAll} />
      <CompleteFollowUpDialog open={!!completing} onOpenChange={(o) => !o && setCompleting(null)} followUp={completing} onDone={refreshAll} />
      {isAdmin ? <AssignDialog open={assignOpen} onOpenChange={setAssignOpen} leadId={l.id} currentOwner={l.owner_id} onDone={refreshAll} /> : null}
      {canEdit ? <ShareFilesDialog open={shareOpen} onOpenChange={setShareOpen} leadId={l.id} leadName={l.name} phone={l.phone_normalized} onShared={timeline.refetch} /> : null}
    </>
  );
}

function StatusSelect({ leadId, status, onChanged }: { leadId: string; status: LeadStatus; onChanged: () => void }) {
  const [optimistic, setOptimistic] = useState<LeadStatus | null>(null);
  const [pending, start] = useTransition();
  return (
    <Select
      value={optimistic ?? status}
      disabled={pending}
      onValueChange={(v) => {
        const next = v as LeadStatus;
        setOptimistic(next);
        start(async () => {
          const r = await setLeadStatus({ id: leadId, status: next });
          setOptimistic(null); // reconcile with the server value
          if (!r.ok) toast.error(r.error);
          else toast.success(`Status: ${STATUS_LABELS[next]}`);
          onChanged();
        });
      }}
    >
      <SelectTrigger className="w-[160px]" aria-label="Change status">
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>{LEAD_STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>)}</SelectContent>
    </Select>
  );
}

function NoteComposer({ leadId, onAdded }: { leadId: string; onAdded: () => void }) {
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const submit = () => {
    if (!body.trim() || pending) return;
    start(async () => {
      const r = await addNote({ leadId, body });
      if (!r.ok) return void toast.error(r.error);
      setBody("");
      toast.success("Note added");
      onAdded();
    });
  };
  return (
    <Card>
      <CardContent className="space-y-2">
        <label htmlFor="note" className="text-sm font-medium">Add note</label>
        <Textarea
          id="note"
          rows={3}
          maxLength={5000}
          placeholder="What happened? (Ctrl+Enter to save)"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); }}
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={pending || !body.trim()}>{pending && <Loader2 className="animate-spin" />}Save note</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CorrectNote({ note, onDone }: { note: Activity; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(note.body ?? "");
  const [pending, start] = useTransition();
  return (
    <>
      <Button variant="link" size="xs" className="h-auto px-0 text-muted-foreground" onClick={() => { setBody(note.body ?? ""); setOpen(true); }}>Correct</Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct note</DialogTitle>
            <DialogDescription>The original text stays in the activity history.</DialogDescription>
          </DialogHeader>
          <Textarea rows={4} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} aria-label="Note" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button
              disabled={pending || !body.trim()}
              onClick={() => start(async () => {
                const r = await correctNote({ noteId: note.id, body });
                if (!r.ok) return void toast.error(r.error);
                toast.success("Note corrected");
                setOpen(false);
                onDone();
              })}
            >
              {pending && <Loader2 className="animate-spin" />}Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ArchiveMenuItem({ leadId, archived, onDone }: { leadId: string; archived: boolean; onDone: () => void }) {
  return (
    <ConfirmDialog
      trigger={<DropdownMenuItem onSelect={(e) => e.preventDefault()}>{archived ? <><ArchiveRestore /> Restore</> : <><Archive /> Archive</>}</DropdownMenuItem>}
      title={archived ? "Restore this lead?" : "Archive this lead?"}
      description={archived ? "The owner will see it again." : "It will be hidden from sales and reminders will stop. History is kept and it can be restored."}
      confirmLabel={archived ? "Restore" : "Archive"}
      destructive={!archived}
      onConfirm={async () => {
        const r = await setLeadArchived({ id: leadId, archived: !archived });
        if (!r.ok) { toast.error(r.error); return false; }
        toast.success(archived ? "Lead restored" : "Lead archived");
        onDone();
      }}
    />
  );
}

function AssignDialog({ open, onOpenChange, leadId, currentOwner, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; leadId: string; currentOwner: string; onDone: () => void }) {
  const [owner, setOwner] = useState<string | null>(currentOwner);
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) { onOpenChange(o); setOwner(currentOwner); } }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reassign lead</DialogTitle>
          <DialogDescription>Pending follow-ups and reminders move to the new owner. The previous owner loses access.</DialogDescription>
        </DialogHeader>
        <StaffSelect value={owner} onChange={setOwner} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button
            disabled={pending || !owner || owner === currentOwner}
            onClick={() => start(async () => {
              const r = await assignLead({ id: leadId, ownerId: owner });
              if (!r.ok) return void toast.error(r.error);
              toast.success("Lead reassigned");
              onOpenChange(false);
              onDone();
            })}
          >
            {pending && <Loader2 className="animate-spin" />}Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <Skeleton className="h-64" />
        <Skeleton className="h-96" />
      </div>
    </div>
  );
}
