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
import { initialLeadPage } from "@/server/initial-data";

export const metadata: Metadata = { title: "Lead" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LeadPage({ params }: PageProps<"/leads/[id]">) {
  const profile = await requireProfile();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const usesLeads = hasAnyRole(profile.roles, ["admin", "sales"]); // authorize before reading the company's niche cache
  // Started together with the company check below, not after it: the lead, its follow-ups and its
  // timeline stream in with the page (not awaited), so the browser does not read them itself first.
  const initial = usesLeads ? initialLeadPage(profile, id) : null;
  const niches = usesLeads ? getCachedNicheOptions(profile.company.id).catch(() => []) : null;
  if (hasAnyRole(profile.roles, ["admin", "ads_manager"]) || profile.companies.length > 1) {
    // A link from Telegram or another tab may point into another company this person works in
    // (the super admin's companies, a client's CRM for the agency's staff, or a sales user's other companies).
    const supabase = await createClient();
    const { data } = await supabase.rpc("lead_company", { p_lead_id: id });
    const target = data as { id: string; name: string; brand_highlight: string | null; logo_path: string | null } | null;
    if (target && target.id !== profile.company.id) return <OpenInCompany company={toCompanyBrand(target)} />;
  }
  if (!initial || !niches) redirect(homePathFor(profile.role));
  return <LeadDetailView leadId={id} initialNiches={await niches} initial={initial} />;
}
