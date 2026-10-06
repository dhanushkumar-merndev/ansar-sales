"use server";

import { z } from "zod";
import { dbError } from "@/lib/errors";
import { runAction } from "@/server/action-utils";

const ROLES: ("admin" | "sales")[] = ["admin", "sales"];
const toggleSchema = z.object({ id: z.uuid(), on: z.boolean() });

export type StarState = { starred: boolean; pinned_at: string | null };

export async function toggleLeadStar(input: unknown) {
  return runAction(ROLES, toggleSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("set_lead_star", { p_lead_id: d.id, p_starred: d.on });
    if (error) return dbError(error);
    return { ok: true, data: data as unknown as StarState };
  });
}

/** Pinning also stars the lead. At most 10 pins (enforced by the database). */
export async function toggleLeadPin(input: unknown) {
  return runAction(ROLES, toggleSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("set_lead_pin", { p_lead_id: d.id, p_pinned: d.on });
    if (error) return dbError(error);
    return { ok: true, data: data as unknown as StarState };
  });
}

export async function toggleFollowUpStar(input: unknown) {
  return runAction(ROLES, toggleSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("set_follow_up_star", { p_follow_up_id: d.id, p_starred: d.on });
    if (error) return dbError(error);
    return { ok: true, data: data as unknown as StarState };
  });
}

export async function toggleFollowUpPin(input: unknown) {
  return runAction(ROLES, toggleSchema, input, async (d, { supabase }) => {
    const { data, error } = await supabase.rpc("set_follow_up_pin", { p_follow_up_id: d.id, p_pinned: d.on });
    if (error) return dbError(error);
    return { ok: true, data: data as unknown as StarState };
  });
}
