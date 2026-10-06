"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Controller, useForm, useWatch, type FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { DateTimeField } from "@/components/common/date-time-field";
import { NicheCombobox, type NicheValue } from "@/components/leads/niche-combobox";
import { StaffSelect } from "@/components/leads/staff-select";
import { useProfile } from "@/components/providers/profile-provider";
import { useStages } from "@/components/providers/stages-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { normalizePhone } from "@/lib/phone";
import { addDays, istToUtcIso, istToday } from "@/lib/time";
import type { NicheOption } from "@/lib/types";
import { checkDuplicatePhone, createLead, updateLead } from "@/server/actions/leads";

const formSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120),
    phone: z.string().trim().min(1, "Phone is required").refine((v) => normalizePhone(v) !== null, "Enter a valid phone number (use +code for other countries)"),
    email: z.union([z.literal(""), z.email("Enter a valid email")]),
    niche: z.custom<NicheValue>((v) => v !== null && v !== undefined, "Choose or create a niche"),
    /** "" = the company's first stage. */
    stageId: z.string(),
    ownerId: z.string().nullable(),
    note: z.string().max(5000),
    scheduleFollowUp: z.boolean(),
    followUp: z.object({ date: z.string(), time: z.string() }),
    followUpTask: z.string().max(500),
  })
  .refine((v) => !v.scheduleFollowUp || (v.followUp.date && v.followUp.time), { message: "Pick a date and time", path: ["followUp"] });

type FormValues = z.infer<typeof formSchema>;

export type EditableLead = { id: string; version: number; name: string; phone: string; email: string | null; niche: NicheOption };

export function LeadFormDialog({
  open, onOpenChange, initialNiches, lead, latestVersion, onSaved,
}: {
  open: boolean; onOpenChange: (open: boolean) => void; initialNiches: NicheOption[];
  /** When provided the dialog edits this lead. */ lead?: EditableLead;
  /** Live version from Realtime; flags a concurrent edit while the dialog is open. */ latestVersion?: number;
  onSaved?: (id: string) => void;
}) {
  const profile = useProfile();
  const { stages } = useStages();
  const isEdit = Boolean(lead);
  const [pending, start] = useTransition();
  const [duplicate, setDuplicate] = useState<{ visibleLeadId: string | null } | null>(null);
  const [phoneWarning, setPhoneWarning] = useState<{ visibleLeadId: string | null } | null>(null);

  const defaults = (): FormValues => ({
    name: lead?.name ?? "",
    phone: lead?.phone ?? "",
    email: lead?.email ?? "",
    niche: lead ? { id: lead.niche.id, label: lead.niche.name } : null,
    stageId: "",
    ownerId: null,
    note: "",
    scheduleFollowUp: false,
    followUp: { date: addDays(istToday(), 1), time: "10:00" },
    followUpTask: "",
  });

  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: defaults() });
  const { register, control, handleSubmit, formState: { errors }, reset } = form;

  // Reset only when the dialog opens: background refreshes never overwrite in-progress input.
  const [wasOpen, setWasOpen] = useState(false);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setDuplicate(null);
      setPhoneWarning(null);
    }
  }
  useEffect(() => {
    if (open) reset(defaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const conflict = isEdit && latestVersion !== undefined && lead && latestVersion !== lead.version;

  const onPhoneBlur = async () => {
    const phone = form.getValues("phone");
    if (!normalizePhone(phone) || (lead && normalizePhone(lead.phone)?.e164 === normalizePhone(phone)?.e164)) {
      setPhoneWarning(null);
      return;
    }
    const r = await checkDuplicatePhone({ phone, excludeLeadId: lead?.id });
    setPhoneWarning(r.ok && r.data.duplicate ? { visibleLeadId: r.data.visibleLeadId } : null);
  };

  const submit = (values: FormValues, allowDuplicate = false) =>
    start(async () => {
      const niche = values.niche!.id ? { id: values.niche!.id } : { newName: values.niche!.newName };
      const result = isEdit
        ? await updateLead({ id: lead!.id, version: lead!.version, name: values.name, phone: values.phone, email: values.email, niche, allowDuplicate })
        : await createLead({
            name: values.name, phone: values.phone, email: values.email, niche, stageId: values.stageId || undefined,
            ownerId: values.ownerId ?? undefined, note: values.note,
            followUpAt: values.scheduleFollowUp ? istToUtcIso(values.followUp.date, values.followUp.time) : undefined,
            followUpTask: values.scheduleFollowUp ? values.followUpTask : undefined,
            allowDuplicate,
          });
      if (!result.ok) {
        if (result.code === "duplicate_phone") {
          setDuplicate({ visibleLeadId: phoneWarning?.visibleLeadId ?? null });
          return;
        }
        for (const [key, messages] of Object.entries(result.fieldErrors ?? {})) {
          const field = key.split(".")[0] as keyof FormValues;
          if (field in values) form.setError(field, { message: messages[0] });
        }
        toast.error(result.error);
        return;
      }
      toast.success(isEdit ? "Lead updated" : "Lead created");
      onOpenChange(false);
      onSaved?.(isEdit ? lead!.id : (result.data as { id: string }).id);
    });

  const scheduleFollowUp = useWatch({ control, name: "scheduleFollowUp" });
  // Invalid fields keep their red outline; the message itself goes to a toast.
  const toastFirstError = (errs: FieldErrors<FormValues>) => {
    const first = Object.values(errs).find((e) => e?.message);
    toast.error(String(first?.message ?? "Check the highlighted fields."));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit lead" : "Add lead"}</DialogTitle>
          <DialogDescription>{isEdit ? "Update contact details and niche." : "Name, phone and niche are required."}</DialogDescription>
        </DialogHeader>
        {conflict ? (
          <div role="alert" className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            This lead was changed by someone else while you were editing. Saving will be rejected; close and reopen to edit the latest version.
          </div>
        ) : null}
        <form id="lead-form" onSubmit={handleSubmit((v) => submit(v), toastFirstError)} noValidate>
          <FieldGroup className="gap-4">
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="lead-name">Name</FieldLabel>
              <Input id="lead-name" autoComplete="off" aria-invalid={!!errors.name} {...register("name")} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.phone}>
                <FieldLabel htmlFor="lead-phone">Phone</FieldLabel>
                <Input id="lead-phone" type="tel" inputMode="tel" placeholder="98765 43210" aria-invalid={!!errors.phone} {...register("phone", { onBlur: onPhoneBlur })} />
              </Field>
              <Field data-invalid={!!errors.email}>
                <FieldLabel htmlFor="lead-email">Email <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
                <Input id="lead-email" type="email" inputMode="email" aria-invalid={!!errors.email} {...register("email")} />
              </Field>
            </div>
            {phoneWarning && !duplicate ? (
              <p className="-mt-2 flex items-center gap-1.5 text-xs text-amber-700">
                <AlertTriangle className="size-3.5" /> A lead with this phone already exists
                {phoneWarning.visibleLeadId ? <> — <Link className="underline" href={`/leads/${phoneWarning.visibleLeadId}`}>open it</Link></> : " (owned by another user)"}.
              </p>
            ) : null}
            <Field data-invalid={!!errors.niche}>
              <FieldLabel htmlFor="lead-niche">Niche</FieldLabel>
              <Controller
                control={control}
                name="niche"
                render={({ field }) => (
                  <NicheCombobox id="lead-niche" value={field.value} onChange={field.onChange} initialOptions={initialNiches} invalid={!!errors.niche} />
                )}
              />
            </Field>
            {!isEdit ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="lead-status">Stage</FieldLabel>
                    <Controller control={control} name="stageId" render={({ field }) => (
                      <Select value={field.value || stages[0]?.id || ""} onValueChange={field.onChange}>
                        <SelectTrigger id="lead-status" className="w-full"><SelectValue placeholder="First stage" /></SelectTrigger>
                        <SelectContent>{stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                      </Select>
                    )} />
                  </Field>
                  {profile.role === "admin" ? (
                    <Field>
                      <FieldLabel htmlFor="lead-owner">Assigned to</FieldLabel>
                      <Controller control={control} name="ownerId" render={({ field }) => (
                        <StaffSelect id="lead-owner" value={field.value} onChange={field.onChange} placeholder="Me" />
                      )} />
                    </Field>
                  ) : null}
                </div>
                <Field>
                  <FieldLabel htmlFor="lead-note">Initial note <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
                  <Textarea id="lead-note" rows={3} {...register("note")} />
                </Field>
                <Field orientation="horizontal">
                  <Controller control={control} name="scheduleFollowUp" render={({ field }) => (
                    <Checkbox id="lead-fu" checked={field.value} onCheckedChange={(c) => field.onChange(c === true)} />
                  )} />
                  <FieldLabel htmlFor="lead-fu" className="font-normal">Schedule a follow-up</FieldLabel>
                </Field>
                {scheduleFollowUp ? (
                  <div className="space-y-3 rounded-md border bg-muted/30 p-3">
                    <Field data-invalid={!!errors.followUp}>
                      <FieldLabel htmlFor="lead-fu-date">When (IST)</FieldLabel>
                      <Controller control={control} name="followUp" render={({ field }) => (
                        <DateTimeField idPrefix="lead-fu" value={field.value} onChange={field.onChange} invalid={!!errors.followUp} />
                      )} />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="lead-fu-task">Task</FieldLabel>
                      <Input id="lead-fu-task" placeholder="Follow up" {...register("followUpTask")} />
                    </Field>
                  </div>
                ) : null}
              </>
            ) : null}
          </FieldGroup>
        </form>
        {duplicate ? (
          <div role="alert" className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-medium">This phone number already belongs to a lead{duplicate.visibleLeadId ? "" : " owned by another user"}.</p>
            <p>Save anyway only if this is intentionally a separate lead.</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" type="button" onClick={() => setDuplicate(null)} disabled={pending}>Go back</Button>
              <Button size="sm" type="button" disabled={pending} onClick={handleSubmit((v) => submit(v, true), toastFirstError)}>
                {pending && <Loader2 className="animate-spin" />} Save duplicate
              </Button>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button type="submit" form="lead-form" disabled={pending || !!duplicate}>
            {pending && <Loader2 className="animate-spin" />}
            {isEdit ? "Save changes" : "Create lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
