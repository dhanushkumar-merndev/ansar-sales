"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Camera, Check, FolderOpen, Loader2, LocateFixed, MapPin, Navigation, Phone, X } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DateTimeField, type IstDateTime } from "@/components/common/date-time-field";
import { RichTextEditor, type RichDoc } from "@/components/common/rich-text";
import { uploadProjectFiles } from "@/components/projects/files/upload";
import { mapsUrl, SiteMap } from "@/components/projects/site-visits/site-map";
import { useProfile } from "@/components/providers/profile-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useLiveQuery } from "@/hooks/use-live-query";
import { roleLabel, type AppRole } from "@/lib/constants";
import { fetchSiteImagesFolder, fetchVisitPeople } from "@/lib/project-queries";
import { SITE_RADIUS_M, VISIT_STATUS_LABELS, type SiteVisit, type SiteVisitStatus } from "@/lib/projects";
import { STAGE_BADGE } from "@/lib/stages";
import { addDays, formatDateTime, istToUtcIso, istToday } from "@/lib/time";
import { cn } from "@/lib/utils";
import { checkInVisit, scheduleVisit, updateVisit } from "@/server/actions/site-visits";

const STATUS_COLOR: Record<SiteVisitStatus, keyof typeof STAGE_BADGE> = { scheduled: "sky", checked_in: "amber", completed: "emerald", cancelled: "slate" };

export function VisitStatusBadge({ status, overdue }: { status: SiteVisitStatus; overdue?: boolean }) {
  if (overdue) return <Badge variant="outline" className={cn("font-medium", STAGE_BADGE.red)}>Missed?</Badge>;
  return <Badge variant="outline" className={cn("font-medium", STAGE_BADGE[STATUS_COLOR[status]])}>{VISIT_STATUS_LABELS[status]}</Badge>;
}

/** Plan a visit for a project or a lead (before there is a project). */
export function ScheduleVisitDialog({ projectId, leadId, title, open, onOpenChange, onDone }: {
  projectId?: string; leadId?: string; title: string; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void;
}) {
  const me = useProfile();
  const [when, setWhen] = useState<IstDateTime>({ date: addDays(istToday(), 1), time: "10:30" });
  const [who, setWho] = useState(me.id);
  const [purpose, setPurpose] = useState("Site visit: photos and measurements");
  const [pending, start] = useTransition();
  const people = useLiveQuery({ queryKey: "visit-people", fetcher: fetchVisitPeople, enabled: open, tables: ["profiles"] });
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) { setWhen({ date: addDays(istToday(), 1), time: "10:30" }); setWho(me.id); }
  }
  const submit = () => start(async () => {
    let at: string;
    try { at = istToUtcIso(when.date, when.time); } catch { toast.error("Choose a valid date and time"); return; }
    const r = await scheduleVisit({ projectId, leadId, assignedTo: who, scheduledAt: at, purpose });
    if (!r.ok) return void toast.error(r.error);
    toast.success("Site visit scheduled");
    onOpenChange(false);
    onDone();
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Schedule a site visit</DialogTitle><DialogDescription>{title}. The visitor gets a Telegram reminder an hour before.</DialogDescription></DialogHeader>
        <FieldGroup className="gap-4">
          <Field><FieldLabel htmlFor="sv-when-date">When (IST)</FieldLabel><DateTimeField idPrefix="sv-when" value={when} onChange={setWhen} /></Field>
          <Field>
            <FieldLabel htmlFor="sv-who">Who goes</FieldLabel>
            <Select value={who} onValueChange={setWho}>
              <SelectTrigger id="sv-who" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(people.data ?? [{ id: me.id, display_name: me.display_name, role: me.role }]).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.display_name}{p.id === me.id ? " (you)" : ""} · {roleLabel(p.role as AppRole, me.features)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field><FieldLabel htmlFor="sv-purpose">Purpose</FieldLabel><Input id="sv-purpose" value={purpose} maxLength={200} onChange={(e) => setPurpose(e.target.value)} /></Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button onClick={submit} disabled={pending || !purpose.trim() || !when.date || !when.time}>{pending && <Loader2 className="animate-spin" />}Schedule</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type GeoState = { state: "idle" } | { state: "locating" } | { state: "error"; message: string };

/** Reads the phone's position (high accuracy, fresh). */
function locate(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("This browser can't share its location."));
    navigator.geolocation.getCurrentPosition(resolve, (e) => reject(new Error(
      e.code === e.PERMISSION_DENIED ? "Location is blocked. Allow location for this site in the browser settings."
        : e.code === e.TIMEOUT ? "Finding your location took too long. Try again outside." : "Your location isn't available right now.")),
    { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 });
  });
}

/** One visit: details, map, GPS check-in, measurements, notes and the outcome. */
export function VisitSheet({ visit, onClose, onChanged }: { visit: SiteVisit | null; onClose: () => void; onChanged: () => void }) {
  const me = useProfile();
  const [geo, setGeo] = useState<GeoState>({ state: "idle" });
  const [setPin, setSetPin] = useState(true);
  const [form, setForm] = useState({ measurements: "", outcome: "", notes: null as RichDoc | null });
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if ((visit?.id ?? null) !== openedFor) {
    setOpenedFor(visit?.id ?? null);
    if (visit) { setForm({ measurements: visit.measurements ?? "", outcome: visit.outcome ?? "", notes: (visit.notes as RichDoc | null) ?? null }); setGeo({ state: "idle" }); }
  }
  if (!visit) return <Sheet open={false} />;
  const open = visit.status === "scheduled" || visit.status === "checked_in";
  const mine = visit.assignee.id === me.id;
  const site = visit.project?.site_lat != null && visit.project.site_lng != null ? { lat: Number(visit.project.site_lat), lng: Number(visit.project.site_lng) } : null;
  const checkIn = visit.check_in_lat != null && visit.check_in_lng != null ? { lat: Number(visit.check_in_lat), lng: Number(visit.check_in_lng), accuracy: visit.check_in_accuracy_m } : null;
  const far = visit.distance_from_site_m != null && visit.distance_from_site_m > SITE_RADIUS_M;

  const doCheckIn = async () => {
    setGeo({ state: "locating" });
    try {
      const pos = await locate();
      const r = await checkInVisit({ id: visit.id, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy, setPin: !site && setPin });
      if (!r.ok) { setGeo({ state: "error", message: r.error }); return; }
      setGeo({ state: "idle" });
      if (r.data.pinned) toast.success("Checked in. This spot is now the project's site pin.");
      else if (r.data.distance_m != null && r.data.distance_m > SITE_RADIUS_M) toast.warning(`Checked in ${r.data.distance_m} m from the site pin.`);
      else toast.success("Checked in on site");
      onChanged();
    } catch (e) {
      setGeo({ state: "error", message: e instanceof Error ? e.message : "Couldn't read the location." });
    }
  };
  const save = (status?: "completed" | "cancelled") => start(async () => {
    const r = await updateVisit({ id: visit.id, version: visit.version, measurements: form.measurements, outcome: form.outcome, notes: form.notes, ...(status ? { status } : {}) });
    if (!r.ok) return void toast.error(r.error);
    toast.success(status === "completed" ? "Visit marked done" : status === "cancelled" ? "Visit cancelled" : "Visit saved");
    onChanged();
    if (status) onClose();
  });

  return (
    <Sheet open onOpenChange={(o) => !o && !pending && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{visit.purpose}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-1.5">
            <VisitStatusBadge status={visit.status} overdue={visit.overdue} />
            <span>{formatDateTime(visit.scheduled_at)} · {visit.assignee.display_name}</span>
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <div className="space-y-1 text-sm">
            {visit.project ? <Link href={`/projects/${visit.project.id}`} className="font-medium hover:underline">{visit.project.name} · {visit.project.code}</Link>
              : visit.lead ? <Link href={`/leads/${visit.lead.id}`} className="font-medium hover:underline">Lead: {visit.lead.name}</Link> : null}
            {visit.project?.site_address ? <div className="flex items-start gap-1.5 text-muted-foreground"><MapPin className="mt-0.5 size-4 shrink-0" />{visit.project.site_address}</div> : null}
            {(visit.project?.client_phone ?? visit.lead?.phone) ? (
              <a href={`tel:${(visit.project?.client_phone ?? visit.lead!.phone).replace(/\s/g, "")}`} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
                <Phone className="size-4" />{visit.project?.client_phone ?? visit.lead!.phone}
              </a>
            ) : null}
          </div>

          {site || checkIn ? <SiteMap site={site} checkIn={checkIn} /> : <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">No site pin yet. Check in at the site to save it.</p>}
          <div className="flex flex-wrap gap-2 text-sm">
            {site ? <a className="inline-flex items-center gap-1 text-sky-300 hover:underline" target="_blank" rel="noreferrer" href={mapsUrl(site.lat, site.lng)}><Navigation className="size-4" />Directions in Google Maps</a> : null}
            {visit.check_in_at ? (
              <span className={cn("inline-flex items-center gap-1", far ? "text-amber-300" : "text-emerald-300")}>
                <Check className="size-4" />Checked in {formatDateTime(visit.check_in_at)}
                {visit.distance_from_site_m != null ? ` · ${visit.distance_from_site_m} m from the pin` : ""}
                {visit.check_in_accuracy_m != null ? ` (±${Math.round(Number(visit.check_in_accuracy_m))} m)` : ""}
              </span>
            ) : null}
          </div>

          {open && (mine || me.roles.includes("admin") || me.roles.includes("architect_manager")) ? (
            <div className="space-y-2 rounded-lg border p-3">
              <Button className="w-full" size="lg" onClick={doCheckIn} disabled={geo.state === "locating"}>
                {geo.state === "locating" ? <Loader2 className="animate-spin" /> : <LocateFixed />}
                {visit.check_in_at ? "Check in again" : "I'm at the site — check in"}
              </Button>
              {!site && visit.project ? (
                <label className="flex cursor-pointer items-center gap-2 text-sm"><Checkbox checked={setPin} onCheckedChange={(v) => setSetPin(v === true)} />Save my position as the site pin</label>
              ) : null}
              {geo.state === "error" ? <p className="text-sm text-red-300" role="alert">{geo.message}</p> : null}
              {far ? <p className="text-sm text-amber-300">More than {SITE_RADIUS_M} m from the saved site pin.</p> : null}
            </div>
          ) : null}

          <Field><FieldLabel htmlFor="sv-measure">Measurements</FieldLabel>
            <Textarea id="sv-measure" rows={3} maxLength={2000} value={form.measurements} disabled={!open && !mine} placeholder="e.g. Front lawn 65 × 12 ft, slope towards the gate"
              onChange={(e) => setForm({ ...form, measurements: e.target.value })} /></Field>
          <Field><FieldLabel>Notes</FieldLabel>
            <RichTextEditor key={visit.id} value={form.notes} onChange={(d) => setForm((f) => ({ ...f, notes: d }))} placeholder="What the client wants, soil, sun, water, access…" /></Field>
          <Field><FieldLabel htmlFor="sv-outcome">Outcome</FieldLabel>
            <Input id="sv-outcome" maxLength={1000} value={form.outcome} placeholder="e.g. Client liked option B, wants a quote by Friday" onChange={(e) => setForm({ ...form, outcome: e.target.value })} /></Field>
          {visit.project ? <SitePhotos projectId={visit.project.id} /> : (
            <p className="text-xs text-muted-foreground">Photos can be added once this lead has a project (its “Site images” folder).</p>
          )}
        </div>
        <SheetFooter className="flex-row flex-wrap gap-2">
          {open ? (
            <ConfirmDialog trigger={<Button variant="ghost" className="text-muted-foreground" disabled={pending}><X /> Cancel visit</Button>}
              title="Cancel this visit?" description="The reminder stops. It stays in the history." confirmLabel="Cancel visit" destructive
              onConfirm={async () => save("cancelled")} />
          ) : null}
          <span className="flex-1" />
          <Button variant="outline" disabled={pending} onClick={() => save()}>{pending && <Loader2 className="animate-spin" />}Save</Button>
          {open ? <Button disabled={pending} onClick={() => save("completed")}><Check /> Mark done</Button> : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Photos from the visit go straight into the project's "Site images" folder (camera or gallery on a phone). */
function SitePhotos({ projectId }: { projectId: string }) {
  const me = useProfile();
  const folder = useLiveQuery({ queryKey: `site-images-folder:${me.id}:${projectId}`, fetcher: (s) => fetchSiteImagesFolder(projectId, s), tables: ["project_folders"] });
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const f = folder.data;
  if (!f) return null; // loading, or not on this project's team
  const upload = async (picked: File[]) => {
    if (!picked.length) return;
    setUploading(true);
    try {
      await uploadProjectFiles(f.id, picked, { folderName: f.name });
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-3">
      <input ref={picker} type="file" multiple className="hidden" accept="image/jpeg,image/png,image/webp,image/heic,.heic" aria-hidden tabIndex={-1}
        onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ""; void upload(picked); }} />
      <Button type="button" variant="outline" onClick={() => picker.current?.click()} disabled={uploading}>
        {uploading ? <Loader2 className="animate-spin" /> : <Camera />} Add site photos
      </Button>
      <Button asChild variant="ghost" size="sm"><Link href={`/projects/${projectId}?tab=files&folder=${f.id}`}><FolderOpen /> Open “{f.name}”</Link></Button>
      <p className="w-full text-xs text-muted-foreground">Saved to the project&apos;s “{f.name}” folder.</p>
    </div>
  );
}
