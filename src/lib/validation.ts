import { z } from "zod";
import { PAYMENT_MODES, ROLES } from "@/lib/constants";
import { normalizePhone } from "@/lib/phone";

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/, "3–32 characters: letters, numbers, dot, dash or underscore");

export const passwordSchema = z.string().min(8, "At least 8 characters").max(72, "At most 72 characters");

const optionalText = (max: number) =>
  z.string().trim().max(max, `At most ${max} characters`).optional().transform((v) => (v ? v : undefined));

const isoDateTime = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();

export const phoneSchema = z
  .string()
  .trim()
  .min(1, "Phone is required")
  .transform((value, ctx) => {
    const n = normalizePhone(value);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Enter a valid phone number (add +country code for non-Indian numbers)" });
      return z.NEVER;
    }
    return n;
  });

export const nicheChoiceSchema = z
  .object({ id: z.uuid().optional(), newName: optionalText(60) })
  .refine((v) => Boolean(v.id || v.newName), { message: "Choose or create a niche" });

export const leadCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  phone: phoneSchema,
  email: z.union([z.literal(""), z.email("Enter a valid email").max(254)]).optional().transform((v) => v || undefined),
  niche: nicheChoiceSchema,
  /** Pipeline stage; the database uses the company's first stage when omitted. */
  stageId: z.uuid().optional(),
  ownerId: z.uuid().optional(),
  note: optionalText(5000),
  followUpAt: isoDateTime.optional(),
  followUpTask: optionalText(500),
  allowDuplicate: z.boolean().default(false),
});

export const leadUpdateSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  name: z.string().trim().min(1, "Name is required").max(120),
  phone: phoneSchema,
  email: z.union([z.literal(""), z.email("Enter a valid email").max(254)]).optional().transform((v) => v || undefined),
  niche: nicheChoiceSchema,
  allowDuplicate: z.boolean().default(false),
});

export const noteSchema = z.object({ leadId: z.uuid(), body: z.string().trim().min(1, "Write a note").max(5000) });
export const noteCorrectionSchema = z.object({ noteId: z.uuid(), body: z.string().trim().min(1, "Write a note").max(5000) });

export const followUpScheduleSchema = z.object({
  leadId: z.uuid(),
  task: z.string().trim().min(1, "Describe the task").max(500),
  dueAt: isoDateTime,
});

export const followUpRescheduleSchema = z.object({
  id: z.uuid(),
  task: z.string().trim().min(1, "Describe the task").max(500),
  dueAt: isoDateTime,
});

export const followUpCompleteSchema = z.object({
  id: z.uuid(),
  outcome: optionalText(1000),
  nextDueAt: isoDateTime.optional(),
  nextTask: optionalText(500),
});

/** Mode of payment, and an optional item with its quantity (nos), shared by capital and expenses. */
const purchaseFields = {
  paymentMode: z.enum(PAYMENT_MODES, "Choose the mode of payment"),
  item: optionalText(120),
  quantity: z.string().trim().regex(/^\d{0,7}$/, "Enter a whole number").optional()
    .transform((v) => (v ? Number(v) : undefined))
    .refine((v) => v === undefined || (v >= 1 && v <= 1_000_000), "Enter a number from 1 to 10,00,000"),
};
const itemForQuantity = (d: { item?: string; quantity?: number }) => d.quantity === undefined || !!d.item;

export const expenseSchema = z.object({
  id: z.uuid().optional(),
  expenseDate: calendarDate,
  /** An existing category, or a new name created in the books on save. */
  category: z.object({ id: z.uuid().optional(), newName: optionalText(40) })
    .refine((v) => Boolean(v.id || v.newName), { message: "Choose or type a category" }),
  /** In merged books: which company the expense is for (defaults to the current company). */
  companyId: z.uuid().optional(),
  amount: z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount with up to 2 decimals").refine((v) => Number(v) > 0, "Amount must be positive"),
  ...purchaseFields,
  description: optionalText(500),
  repeatMonthly: z.boolean().default(false),
}).refine(itemForQuantity, { path: ["item"], message: "Name the item for this quantity" });

export const capitalSchema = z.object({
  id: z.uuid().optional(),
  entryDate: calendarDate,
  contributor: z.string().trim().min(1, "Who contributed?").max(120),
  companyId: z.uuid().optional(),
  amount: z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount with up to 2 decimals").refine((v) => Number(v) > 0, "Amount must be positive"),
  ...purchaseFields,
  description: optionalText(500),
}).refine(itemForQuantity, { path: ["item"], message: "Name the item for this quantity" });

export const createUserSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1, "Display name is required").max(80),
  role: z.enum(ROLES),
  password: passwordSchema,
});

export const updateUserSchema = z.object({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(80).optional(),
  role: z.enum(ROLES).optional(),
  isActive: z.boolean().optional(),
});

export const loginSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(128) });

export type LeadCreateInput = z.input<typeof leadCreateSchema>;
export type LeadUpdateInput = z.input<typeof leadUpdateSchema>;
