import type { Metadata } from "next";
import { PortalView } from "@/components/ads/portal-view";
import { ProjectPortalView } from "@/components/projects/portal/project-portal-view";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Your portal" };

/** Clients' read-only portal: ads clients see their ad results, project clients their project. */
export default async function PortalPage() {
  const profile = await requireProfile(["client"]);
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("ads_client_id").eq("id", profile.id).maybeSingle();
  return data?.ads_client_id ? <PortalView /> : <ProjectPortalView />;
}
