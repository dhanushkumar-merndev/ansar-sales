import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OpenInCompany } from "@/components/app/open-in-company";
import { LeadDetailView } from "@/components/leads/lead-detail-view";
import { requireProfile } from "@/lib/auth";
import { getCachedNicheOptions } from "@/lib/niches-cache";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Lead" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LeadPage({ params }: PageProps<"/leads/[id]">) {
  const profile = await requireProfile(["admin", "sales"]);
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  if (profile.isSuperAdmin) {
    // A link from Telegram or another tab may point into a company other than the active one.
    const supabase = await createClient();
    const { data: companyId } = await supabase.rpc("super_lead_company", { p_lead_id: id });
    const target = companyId && companyId !== profile.company.id ? profile.companies.find((c) => c.id === companyId) : null;
    if (target) return <OpenInCompany company={target} />;
  }
  const niches = await getCachedNicheOptions(profile.company.id).catch(() => []);
  return <LeadDetailView leadId={id} initialNiches={niches} />;
}
