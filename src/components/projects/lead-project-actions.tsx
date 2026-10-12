"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderKanban, Hand, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { CreateProjectDialog } from "@/components/projects/create-project-dialog";
import { ScheduleVisitDialog } from "@/components/projects/site-visits/visit-dialogs";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { LeadDetail } from "@/lib/queries";
import { formatRelative } from "@/lib/time";
import { handoffLead } from "@/server/actions/projects";

/** Projects module on a lead: BDM hands it to the admins; admin turns it into a project. */
export function LeadProjectActions({ lead, onChanged }: { lead: LeadDetail; onChanged: () => void }) {
  const me = useProfile();
  const router = useRouter();
  const [handing, setHanding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [visiting, setVisiting] = useState(false);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  if (!me.features.includes("projects") || lead.archived_at) return null;
  const project = Array.isArray(lead.projects) ? lead.projects[0] : lead.projects;
  const isAdmin = me.roles.includes("admin");

  const visit = (
    <>
      <Button variant="outline" onClick={() => setVisiting(true)}><MapPin /> Site visit</Button>
      <ScheduleVisitDialog leadId={lead.id} title={`For ${lead.name}`} open={visiting} onOpenChange={setVisiting} onDone={onChanged} />
    </>
  );
  if (project) {
    return <Button variant="outline" asChild><Link href={`/projects/${project.id}`}><FolderKanban /> Project {project.code}</Link></Button>;
  }
  return (
    <>
      {visit}
      {isAdmin ? <Button onClick={() => setCreating(true)}><FolderKanban /> Create project</Button> : null}
      {!isAdmin && lead.handoff_at ? (
        <Badge variant="outline" className="h-9 gap-1.5 border-amber-400/30 bg-amber-400/10 px-3 text-amber-300"><Hand className="size-3.5" />Handed to admin {formatRelative(lead.handoff_at)}</Badge>
      ) : null}
      {!isAdmin && !lead.handoff_at ? <Button variant="outline" onClick={() => setHanding(true)}><Hand /> Hand over to Admin</Button> : null}

      <Dialog open={handing} onOpenChange={(o) => !pending && setHanding(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Hand {lead.name} to Admin?</DialogTitle>
            <DialogDescription>The admins are told the client is interested, and can create the project with the architect manager and designer.</DialogDescription>
          </DialogHeader>
          <Textarea value={note} maxLength={1000} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="What does the client want? Budget, site size, timing…" aria-label="Handover note" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setHanding(false)} disabled={pending}>Cancel</Button>
            <Button disabled={pending} onClick={() => start(async () => {
              const r = await handoffLead({ leadId: lead.id, note });
              if (!r.ok) return void toast.error(r.error);
              toast.success("Handed over to the admins");
              setHanding(false);
              setNote("");
              onChanged();
            })}>{pending && <Loader2 className="animate-spin" />}Hand over</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {isAdmin ? (
        <CreateProjectDialog open={creating} onOpenChange={setCreating} lead={{ id: lead.id, name: lead.name, phone: lead.phone, email: lead.email }}
          onCreated={(id) => router.push(`/projects/${id}`)} />
      ) : null}
    </>
  );
}
