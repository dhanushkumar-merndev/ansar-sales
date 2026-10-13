import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { OpenInCompany } from "@/components/app/open-in-company";
import { LeadDetailView } from "@/components/leads/lead-detail-view";
import { requireProfile } from "@/lib/auth";
import { toCompanyBrand } from "@/lib/companies";
import { homePathFor } from "@/lib/constants";
import { hasAnyRole } from "@/lib/permissions";
import { getCachedNicheOptions } from "@/lib/niches-cache";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Lead" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LeadPage({ params }: PageProps<"/leads/[id]">) {
  const profile = await requireProfile();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  if (hasAnyRole(profile.roles, ["admin", "ads_manager"])) {
    // A link from Telegram or another tab may point into another company this person works in
    // (the super admin's companies, or a client's CRM for the agency's staff).
    const supabase = await createClient();
    const { data } = await supabase.rpc("lead_company", { p_lead_id: id });
    const target = data as { id: string; name: string; brand_highlight: string | null; logo_path: string | null } | null;
    if (target && target.id !== profile.company.id) return <OpenInCompany company={toCompanyBrand(target)} />;
  }
  if (!hasAnyRole(profile.roles, ["admin", "sales"])) redirect(homePathFor(profile.role));
  const niches = await getCachedNicheOptions(profile.company.id).catch(() => []);
  return <LeadDetailView leadId={id} initialNiches={niches} />;
}
