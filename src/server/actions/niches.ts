"use server";

import { updateTag } from "next/cache";
import { z } from "zod";
import { dbError } from "@/lib/errors";
import { nichesTag } from "@/lib/niches-cache";
import { runAction } from "@/server/action-utils";

export async function renameNiche(input: unknown) {
  return runAction(["admin"], z.object({ id: z.uuid(), name: z.string().trim().min(1).max(60) }), input, async (d, { supabase, profile }) => {
    const { data, error } = await supabase.from("niches").update({ name: d.name }).eq("id", d.id).select("id").maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    updateTag(nichesTag(profile.company.id));
    return { ok: true, data: undefined };
  });
}

export async function setNicheArchived(input: unknown) {
  return runAction(["admin"], z.object({ id: z.uuid(), archived: z.boolean() }), input, async (d, { supabase, profile }) => {
    const { data, error } = await supabase
      .from("niches")
      .update({ archived_at: d.archived ? new Date().toISOString() : null })
      .eq("id", d.id)
      .is("merged_into_id", null)
      .select("id")
      .maybeSingle();
    if (error) return dbError(error);
    if (!data) return dbError({ message: "not_found" });
    updateTag(nichesTag(profile.company.id));
    return { ok: true, data: undefined };
  });
}

export async function mergeNiches(input: unknown) {
  return runAction(["admin"], z.object({ sourceId: z.uuid(), targetId: z.uuid() }), input, async (d, { supabase, profile }) => {
    const { data, error } = await supabase.rpc("merge_niches", { p_source_id: d.sourceId, p_target_id: d.targetId });
    if (error) return dbError(error);
    updateTag(nichesTag(profile.company.id));
    return { ok: true, data: { movedLeads: data } };
  });
}
