import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LeadDetailView } from "@/components/leads/lead-detail-view";
import { requireProfile } from "@/lib/auth";
import { getCachedNicheOptions } from "@/lib/niches-cache";

export const metadata: Metadata = { title: "Lead" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LeadPage({ params }: PageProps<"/leads/[id]">) {
  await requireProfile(["admin", "sales"]);
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const niches = await getCachedNicheOptions().catch(() => []);
  return <LeadDetailView leadId={id} initialNiches={niches} />;
}
