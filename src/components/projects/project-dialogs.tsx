"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Loader2, UserMinus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { ColorSwatchPicker } from "@/components/common/color-swatch-picker";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DateField } from "@/components/common/date-time-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLiveQuery } from "@/hooks/use-live-query";
import { formatINR } from "@/lib/format";
import { fetchRolePeople } from "@/lib/project-queries";
import { MEMBER_ROLE_LABELS, PROJECT_STATUSES, PROJECT_STATUS_LABELS, type ProjectDetail, type ProjectMemberRole } from "@/lib/projects";
import { setProjectFinancials, setProjectMember, updateProject } from "@/server/actions/projects";

type P = ProjectDetail["project"];

export function EditProjectDialog({ project, open, onOpenChange, onDone }: { project: P; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const init = () => ({
    name: project.name, clientName: project.client_name, clientPhone: project.client_phone ?? "", clientEmail: project.client_email ?? "",
    siteAddress: project.site_address ?? "", startDate: project.start_date, endDate: project.end_date, status: project.status, color: project.color,
  });
  const [form, setForm] = useState(init);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const [openedAt, setOpenedAt] = useState<boolean>(false);
  if (open !== openedAt) {
    setOpenedAt(open);
    if (open) { setForm(init()); setErrors({}); }
  }
  const set = <K extends keyof ReturnType<typeof init>>(k: K, v: ReturnType<typeof init>[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = () => start(async () => {
    const r = await updateProject({ id: project.id, version: project.version, ...form });
    if (!r.ok) { setErrors(r.fieldErrors ?? {}); toast.error(r.error); return; }
    toast.success("Project updated");
    onOpenChange(false);
    onDone();
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>Edit {project.code}</DialogTitle><DialogDescription>Client, site, dates and status.</DialogDescription></DialogHeader>
        <FieldGroup className="gap-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
            <Field data-invalid={!!errors.name}><FieldLabel htmlFor="ep-name">Project name</FieldLabel><Input id="ep-name" value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} /></Field>
            <Field><FieldLabel htmlFor="ep-color">Colour</FieldLabel><ColorSwatchPicker id="ep-color" value={form.color} onChange={(c) => set("color", c)} /></Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={!!errors.clientName}><FieldLabel htmlFor="ep-client">Client name</FieldLabel><Input id="ep-client" value={form.clientName} maxLength={120} onChange={(e) => set("clientName", e.target.value)} /></Field>
            <Field data-invalid={!!errors.clientPhone}>
              <FieldLabel htmlFor="ep-phone">Client phone</FieldLabel><Input id="ep-phone" type="tel" value={form.clientPhone} onChange={(e) => set("clientPhone", e.target.value)} />
              <FieldError errors={errors.clientPhone?.map((message) => ({ message }))} />
            </Field>
          </div>
          <Field data-invalid={!!errors.clientEmail}>
            <FieldLabel htmlFor="ep-email">Client email</FieldLabel><Input id="ep-email" type="email" value={form.clientEmail} onChange={(e) => set("clientEmail", e.target.value)} />
            <FieldError errors={errors.clientEmail?.map((message) => ({ message }))} />
          </Field>
          <Field><FieldLabel htmlFor="ep-site">Site address</FieldLabel><Input id="ep-site" value={form.siteAddress} maxLength={500} onChange={(e) => set("siteAddress", e.target.value)} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field><FieldLabel htmlFor="ep-start">Start date</FieldLabel><DateField id="ep-start" value={form.startDate} onChange={(v) => set("startDate", v)} /></Field>
            <Field data-invalid={form.endDate < form.startDate}>
              <FieldLabel htmlFor="ep-end">End date</FieldLabel><DateField id="ep-end" value={form.endDate} onChange={(v) => set("endDate", v)} invalid={form.endDate < form.startDate} />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="ep-status">Status</FieldLabel>
            <Select value={form.status} onValueChange={(v) => set("status", v as P["status"])}>
              <SelectTrigger id="ep-status" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{PROJECT_STATUSES.map((s) => <SelectItem key={s} value={s}>{PROJECT_STATUS_LABELS[s]}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button onClick={save} disabled={pending || !form.name.trim() || !form.clientName.trim() || form.endDate < form.startDate}>{pending && <Loader2 className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FinancialsDialog({ projectId, financials, open, onOpenChange, onDone }: {
  projectId: string; financials: ProjectDetail["financials"]; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void;
}) {
  const init = () => ({
    areaSqft: financials?.area_sqft != null ? String(financials.area_sqft) : "",
    ratePerSqft: financials?.rate_per_sqft != null ? String(financials.rate_per_sqft) : "",
    contractValue: financials?.contract_value != null ? String(financials.contract_value) : "",
  });
  const [form, setForm] = useState(init);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, start] = useTransition();
  const [openedAt, setOpenedAt] = useState(false);
  if (open !== openedAt) {
    setOpenedAt(open);
    if (open) { setForm(init()); setErrors({}); }
  }
  const area = Number(form.areaSqft), rate = Number(form.ratePerSqft);
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Project value</DialogTitle><DialogDescription>Seen by Admin and Accounts only.</DialogDescription></DialogHeader>
        <FieldGroup className="gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field data-invalid={!!errors.areaSqft}><FieldLabel htmlFor="f-area">Area (sq ft)</FieldLabel><Input id="f-area" inputMode="decimal" value={form.areaSqft} onChange={(e) => setForm({ ...form, areaSqft: e.target.value })} /></Field>
            <Field data-invalid={!!errors.ratePerSqft}><FieldLabel htmlFor="f-rate">Rate (₹/sq ft)</FieldLabel><Input id="f-rate" inputMode="decimal" value={form.ratePerSqft} onChange={(e) => setForm({ ...form, ratePerSqft: e.target.value })} /></Field>
          </div>
          {area > 0 && rate >= 0 && form.ratePerSqft ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setForm({ ...form, contractValue: String(Math.round(area * rate * 100) / 100) })}>
              Use area × rate = {formatINR(area * rate)}
            </Button>
          ) : null}
          <Field data-invalid={!!errors.contractValue}>
            <FieldLabel htmlFor="f-value">Contract value (₹)</FieldLabel>
            <Input id="f-value" inputMode="decimal" value={form.contractValue} onChange={(e) => setForm({ ...form, contractValue: e.target.value })} />
            <FieldDescription>{form.contractValue ? formatINR(form.contractValue) : "The agreed total for the client."}</FieldDescription>
            <FieldError errors={errors.contractValue?.map((message) => ({ message }))} />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button disabled={pending} onClick={() => start(async () => {
            const r = await setProjectFinancials({ projectId, ...form });
            if (!r.ok) { setErrors(r.fieldErrors ?? {}); toast.error(r.error); return; }
            toast.success("Project value saved");
            onOpenChange(false);
            onDone();
          })}>{pending && <Loader2 className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TEAM_ROLES: Exclude<ProjectMemberRole, "client">[] = ["architect_manager", "landscape_designer", "execution"];

/** Team list with add/remove for managers (architect managers can't add another architect manager). */
export function TeamEditor({ projectId, members, canManage, isAdmin, onChanged }: {
  projectId: string; members: ProjectDetail["members"]; canManage: boolean; isAdmin: boolean; onChanged: () => void;
}) {
  const [adding, setAdding] = useState<(typeof TEAM_ROLES)[number] | null>(null);
  const [person, setPerson] = useState("");
  const [pending, start] = useTransition();
  const people = useLiveQuery({
    queryKey: `role-people:${adding ?? "none"}`, fetcher: (s) => fetchRolePeople(adding!, s), enabled: !!adding, tables: ["profiles"],
  });
  const change = (userId: string, role: (typeof TEAM_ROLES)[number], on: boolean) => start(async () => {
    const r = await setProjectMember({ projectId, userId, role, on });
    if (!r.ok) return void toast.error(r.error);
    toast.success(on ? "Added to the team" : "Removed from the team");
    setAdding(null);
    setPerson("");
    onChanged();
  });
  const roles = TEAM_ROLES.filter((r) => isAdmin || r !== "architect_manager");
  return (
    <div className="space-y-3">
      {TEAM_ROLES.map((role) => {
        const list = members.filter((m) => m.role === role);
        return (
          <div key={role}>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{MEMBER_ROLE_LABELS[role]}</div>
            {list.length ? (
              <ul className="space-y-1">
                {list.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                    <span>{m.display_name}</span>
                    {canManage && (isAdmin || role !== "architect_manager") ? (
                      <ConfirmDialog
                        trigger={<Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.display_name}`}><UserMinus /></Button>}
                        title={`Remove ${m.display_name}?`}
                        description="They lose access to this project. Their open phases become unassigned."
                        confirmLabel="Remove" destructive onConfirm={async () => change(m.id, role, false)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">Nobody yet</p>}
          </div>
        );
      })}
      {canManage ? (
        adding ? (
          // Stacked: this sits in the narrow side column of the project page.
          <div className="space-y-2 rounded-lg border p-2">
            <Select value={adding} onValueChange={(v) => { setAdding(v as typeof adding); setPerson(""); }}>
              <SelectTrigger className="w-full min-w-0" aria-label="Role"><SelectValue /></SelectTrigger>
              <SelectContent>{roles.map((r) => <SelectItem key={r} value={r}>{MEMBER_ROLE_LABELS[r]}</SelectItem>)}</SelectContent>
            </Select>
            {people.data?.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">
                Nobody has the {MEMBER_ROLE_LABELS[adding].toLowerCase()} role yet.{isAdmin ? <> Give it to someone in <Link href="/users" className="underline underline-offset-2">Users</Link>.</> : " Ask an admin to add it."}
              </p>
            ) : (
              <Select value={person} onValueChange={setPerson}>
                <SelectTrigger className="w-full min-w-0" aria-label="Person"><SelectValue placeholder={people.data ? "Choose a person" : "Loading…"} /></SelectTrigger>
                <SelectContent>
                  {(people.data ?? []).filter((p) => !members.some((m) => m.id === p.id && m.role === adding)).map((p) => <SelectItem key={p.id} value={p.id}>{p.display_name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
              <Button size="sm" disabled={!person || pending} onClick={() => change(person, adding, true)}>{pending && <Loader2 className="animate-spin" />}Add</Button>
            </div>
          </div>
        ) : <Button variant="outline" size="sm" onClick={() => setAdding(isAdmin ? "architect_manager" : "landscape_designer")}><UserPlus /> Add person</Button>
      ) : null}
    </div>
  );
}
