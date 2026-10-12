import { z } from "zod";
import { normalizePhone } from "@/lib/phone";
import { PAYMENT_MODES } from "@/lib/constants";
import { PHASE_STATUSES, PROJECT_COLORS, PROJECT_STATUSES } from "@/lib/projects";

const date = z.iso.date();
const color = z.enum(PROJECT_COLORS);
const text = (max: number) => z.string().trim().max(max, `At most ${max} characters`);
const optional = (max: number) => text(max).optional().transform((v) => (v ? v : undefined));
/** Rupees with up to 2 decimals, sent as a string to keep them exact. */
const amount = z.union([z.literal(""), z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount like 780000 or 1250.50")])
  .optional().transform((v) => (v ? v : undefined));
const quantity = z.union([z.literal(""), z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, "Enter a number")])
  .optional().transform((v) => (v ? v : undefined));

const optionalPhone = z.string().trim().max(32).optional().transform((v, ctx) => {
  if (!v) return undefined;
  const n = normalizePhone(v);
  if (!n) {
    ctx.addIssue({ code: "custom", message: "Enter a valid phone number" });
    return z.NEVER;
  }
  return n.display;
});
const optionalEmail = z.union([z.literal(""), z.email("Enter a valid email").max(254)]).optional().transform((v) => v || undefined);

/** Tiptap JSON document; size is capped again by the database. */
export const richTextSchema = z
  .object({ type: z.literal("doc") })
  .passthrough()
  .refine((d) => JSON.stringify(d).length <= 150_000, "Notes are too long")
  .nullable();

export const phaseDraftSchema = z.object({
  category: text(60).min(1, "Stage is required"),
  name: text(120).min(1, "Name is required"),
  color,
  planned_start: date,
  deadline: date,
  needs_client_approval: z.boolean().default(false),
  owner_id: z.uuid().nullable().optional(),
  items: z.array(text(200).min(1)).max(40).default([]),
}).refine((p) => p.deadline >= p.planned_start, { message: "Deadline is before the start", path: ["deadline"] });

export const projectCreateSchema = z.object({
  leadId: z.uuid().optional(),
  name: text(120).min(1, "Project name is required"),
  clientName: text(120).min(1, "Client name is required"),
  clientPhone: optionalPhone,
  clientEmail: optionalEmail,
  siteAddress: optional(500),
  startDate: date,
  endDate: date,
  color: color.default("emerald"),
  areaSqft: quantity,
  ratePerSqft: amount,
  contractValue: amount,
  architectManagerId: z.uuid().optional(),
  designerIds: z.array(z.uuid()).max(10).default([]),
  executionIds: z.array(z.uuid()).max(10).default([]),
  phases: z.array(phaseDraftSchema).max(80),
  milestones: z.array(z.object({
    label: text(80).min(1),
    percent: z.number().positive().max(100),
    amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/),
    due_trigger: z.enum(["date", "phase"]),
    due_date: date.optional(),
    phase_index: z.number().int().positive().optional(),
  })).max(20).default([]),
  markWon: z.boolean().default(true),
}).refine((p) => p.endDate >= p.startDate, { message: "End date is before the start", path: ["endDate"] });

export const projectUpdateSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  name: text(120).min(1, "Project name is required"),
  clientName: text(120).min(1, "Client name is required"),
  clientPhone: optionalPhone,
  clientEmail: optionalEmail,
  siteAddress: optional(500),
  startDate: date,
  endDate: date,
  status: z.enum(PROJECT_STATUSES),
  color,
}).refine((p) => p.endDate >= p.startDate, { message: "End date is before the start", path: ["endDate"] });

export const projectFinancialsSchema = z.object({
  projectId: z.uuid(), areaSqft: quantity, ratePerSqft: amount, contractValue: amount,
});

export const projectMemberSchema = z.object({
  projectId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(["architect_manager", "landscape_designer", "execution"]),
  on: z.boolean(),
});

/** Managers: any field. Owners: the progress fields only (enforced by the database). */
export const phaseSaveSchema = z.object({
  projectId: z.uuid(),
  id: z.uuid().optional(),
  version: z.number().int().positive().optional(),
  category: text(60).min(1, "Stage is required"),
  name: text(120).min(1, "Name is required"),
  color,
  ownerId: z.uuid().nullable(),
  plannedStart: date,
  deadline: date,
  actualStart: date.nullable(),
  submittedOn: date.nullable(),
  status: z.enum(PHASE_STATUSES),
  needsClientApproval: z.boolean(),
  remark: optional(500),
  notes: richTextSchema.optional(),
}).refine((p) => p.deadline >= p.plannedStart, { message: "Deadline is before the start", path: ["deadline"] })
  .refine((p) => !p.actualStart || !p.submittedOn || p.submittedOn >= p.actualStart, { message: "Can't be before it started", path: ["submittedOn"] });

export const phaseProgressSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  status: z.enum(PHASE_STATUSES).optional(),
  actualStart: date.nullable().optional(),
  submittedOn: date.nullable().optional(),
  remark: optional(500).nullable(),
  notes: richTextSchema.optional(),
}).refine((p) => !p.actualStart || !p.submittedOn || p.submittedOn >= p.actualStart, { message: "Can't be before it started", path: ["submittedOn"] });

/** One field (or a few) edited in place in the timeline sheet; the database decides who may change what. */
export const phasePatchSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  name: text(120).min(1, "Name is required").optional(),
  category: text(60).min(1, "Stage is required").optional(),
  ownerId: z.uuid().nullable().optional(),
  plannedStart: date.optional(),
  deadline: date.optional(),
  submittedOn: date.nullable().optional(),
  remark: text(500).nullable().optional(),
}).refine((p) => !p.plannedStart || !p.deadline || p.deadline >= p.plannedStart, { message: "Deadline is before the start", path: ["deadline"] });

/** A new phase typed straight into the sheet, placed after `afterId` (or at the end). */
export const phaseQuickAddSchema = z.object({
  projectId: z.uuid(),
  category: text(60).min(1, "Stage is required"),
  name: text(120).min(1, "Name is required"),
  afterId: z.uuid().optional(),
  items: z.array(text(200).min(1)).max(30).default([]),
  /** Picked in the Gantt's "Add" dialog; otherwise the day after the phase before it. */
  plannedStart: date.optional(),
  deadline: date.optional(),
}).refine((p) => !p.plannedStart || !p.deadline || p.deadline >= p.plannedStart, { message: "Deadline is before the start", path: ["deadline"] });
export const stageRenameSchema = z.object({ projectId: z.uuid(), from: text(60).min(1), to: text(60).min(1, "Stage is required") });
export const phaseItemOrderSchema = z.object({ phaseId: z.uuid(), ids: z.array(z.uuid()).min(1).max(100) });

export const phaseItemSchema = z.object({ phaseId: z.uuid(), title: text(200).min(1, "Write the item") });
/** The phase drawer's checklist edits, applied together when the phase is saved (Cancel throws them away). */
export const phaseChecklistSchema = z.object({
  phaseId: z.uuid(),
  add: z.array(z.object({ title: text(200).min(1), done: z.boolean().default(false) })).max(30).default([]),
  change: z.array(z.object({ id: z.uuid(), done: z.boolean() })).max(100).default([]),
  remove: z.array(z.uuid()).max(100).default([]),
});
export const phaseItemUpdateSchema = z.object({
  id: z.uuid(), title: text(200).min(1).optional(), done: z.boolean().optional(), archived: z.boolean().optional(),
});
export const reorderSchema = z.object({ projectId: z.uuid(), ids: z.array(z.uuid()).min(1).max(200) });
export const projectNoteSchema = z.object({ projectId: z.uuid(), body: text(5000).min(1, "Write a note") });
export const handoffSchema = z.object({ leadId: z.uuid(), note: optional(1000) });

export type ProjectCreateInput = z.input<typeof projectCreateSchema>;
export type PhaseSaveInput = z.input<typeof phaseSaveSchema>;

const requiredAmount = z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount like 50000 or 1250.50")
  .refine((v) => Number(v) > 0, "The amount must be more than zero");

export const milestoneSchema = z.object({
  projectId: z.uuid(),
  id: z.uuid().optional(),
  version: z.number().int().positive().optional(),
  label: text(80).min(1, "Name the payment"),
  percent: z.union([z.literal(""), z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "0–100")]).optional()
    .transform((v) => (v ? Number(v) : null)).refine((v) => v === null || (v > 0 && v <= 100), "Between 0 and 100"),
  amount: z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount"),
  dueTrigger: z.enum(["date", "phase"]),
  dueDate: date.optional(),
  phaseId: z.uuid().optional(),
  notes: optional(500),
}).refine((m) => (m.dueTrigger === "date" ? Boolean(m.dueDate) : Boolean(m.phaseId)), { message: "Choose when it is due", path: ["dueDate"] });

export const paymentSchema = z.object({
  projectId: z.uuid(),
  id: z.uuid().optional(),
  version: z.number().int().positive().optional(),
  /** Extra work outside the schedule. Otherwise the payment fills the schedule's parts, oldest first. */
  isExtra: z.boolean().default(false),
  amount: requiredAmount,
  paidOn: date,
  mode: z.enum(PAYMENT_MODES),
  reference: optional(120),
  notes: optional(1000),
});

export const visitScheduleSchema = z.object({
  projectId: z.uuid().optional(),
  leadId: z.uuid().optional(),
  assignedTo: z.uuid(),
  scheduledAt: z.iso.datetime({ offset: true }),
  purpose: text(200).min(1, "What is the visit for?"),
}).refine((v) => Boolean(v.projectId || v.leadId), { message: "Choose a project or lead" });

export const visitUpdateSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  assignedTo: z.uuid().optional(),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
  purpose: text(200).min(1).optional(),
  status: z.enum(["scheduled", "completed", "cancelled"]).optional(),
  notes: richTextSchema.optional(),
  measurements: text(2000).optional(),
  outcome: text(1000).optional(),
});

export const checkInSchema = z.object({
  id: z.uuid(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000),
  setPin: z.boolean().default(false),
});

const qtyNumber = z.union([z.number(), z.string().trim().regex(/^\d{0,10}(\.\d{1,2})?$/, "Enter a number")])
  .transform((v) => (v === "" ? 0 : Number(v))).refine((v) => v >= 0 && v < 1e10, "Enter a number");

export const boqRevisionSchema = z.object({ projectId: z.uuid(), label: text(20).min(1, "Label it, e.g. R2"), title: optional(120), copyFrom: z.uuid().optional() });
export const boqStatusSchema = z.object({ id: z.uuid(), version: z.number().int().positive(), status: z.enum(["draft", "sent", "client_approved"]) });
export const boqItemSchema = z.object({
  revisionId: z.uuid(),
  id: z.uuid().optional(),
  section: text(40).min(1),
  item: text(200).min(1, "Name the item"),
  description: optional(500),
  unit: text(20).min(1),
  qty: qtyNumber,
  rate: qtyNumber,
});
export const boqExecutedSchema = z.object({ id: z.uuid(), executedQty: qtyNumber });
export const siteLogSchema = z.object({
  projectId: z.uuid(),
  id: z.uuid().optional(),
  version: z.number().int().positive().optional(),
  logDate: date,
  workDone: richTextSchema,
  workers: z.number().int().min(0).max(1000).nullable(),
  issues: optional(2000),
});
export const snagSchema = z.object({
  projectId: z.uuid(),
  id: z.uuid().optional(),
  version: z.number().int().positive().optional(),
  title: text(200).min(1, "Describe what to fix"),
  details: optional(2000),
  ownerId: z.uuid().nullable(),
  dueDate: date.nullable(),
  status: z.enum(["open", "fixed", "verified"]).optional(),
});
