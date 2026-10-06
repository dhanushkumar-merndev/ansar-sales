import { randomBytes, randomInt } from "node:crypto";
import { normalizePhone } from "../../../src/lib/phone";
import type { Db } from "./supabase";

/** Unique, searchable marker for the rows a test creates (e.g. "E2E 9f3a1c"). */
export const tag = (prefix = "E2E") => `${prefix} ${randomBytes(3).toString("hex")}`;

/** A valid, practically unique Indian mobile number in display and E.164 form. */
export function phone() {
  const n = normalizePhone(`98${randomInt(10_000_000, 99_999_999)}`);
  if (!n) throw new Error("phone fixture invalid");
  return n;
}

export type LeadStatus = "new" | "contacted" | "interested" | "proposal_sent" | "won" | "lost";

/** Creates a lead through the same RPC the app uses, as whichever user `client` is. */
export async function createLead(
  client: Db,
  o: {
    name: string;
    niche?: { id: string } | { newName: string };
    ownerId?: string;
    status?: LeadStatus;
    email?: string;
    note?: string;
    followUpAt?: Date;
    followUpTask?: string;
    phone?: { e164: string; display: string };
  },
) {
  const p = o.phone ?? phone();
  const niche = o.niche ?? { newName: "E2E General" };
  const { data, error } = await client.rpc("create_lead", {
    p_name: o.name,
    p_phone: p.display,
    p_phone_normalized: p.e164,
    p_email: o.email,
    p_niche_id: "id" in niche ? niche.id : undefined,
    p_new_niche: "newName" in niche ? niche.newName : undefined,
    p_status: o.status,
    p_owner_id: o.ownerId,
    p_note: o.note,
    p_follow_up_at: o.followUpAt?.toISOString(),
    p_follow_up_task: o.followUpTask,
    p_allow_duplicate: true,
  });
  if (error) throw new Error(`create_lead failed: ${error.message}`);
  return { id: data as string, phone: p };
}

/** Inserts a follow-up as `client` (any due time, including the past, to exercise overdue states). */
export async function addFollowUp(client: Db, userId: string, leadId: string, dueAt: Date, task: string) {
  const { data, error } = await client
    .from("follow_ups")
    .insert({ lead_id: leadId, task, due_at: dueAt.toISOString(), created_by: userId } as never)
    .select("id")
    .single();
  if (error) throw new Error(`follow-up insert failed: ${error.message}`);
  return (data as { id: string }).id;
}

const istFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** IST wall-clock parts of an instant: { date: "YYYY-MM-DD", time: "HH:mm" }. */
export function ist(d: Date) {
  const p = Object.fromEntries(istFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
