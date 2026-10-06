import type { Metadata } from "next";
import { LeadsView } from "@/components/leads/leads-view";
import { requireProfile } from "@/lib/auth";
import { getCachedNicheOptions } from "@/lib/niches-cache";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage() {
  const { company } = await requireProfile(["admin", "sales"]); // authorize before reading the company's niche cache
  const niches = await getCachedNicheOptions(company.id).catch(() => []);
  return <LeadsView initialNiches={niches} />;
}
