import type { Metadata } from "next";
import { LeadsView } from "@/components/leads/leads-view";
import { requireProfile } from "@/lib/auth";
import { getCachedNicheOptions } from "@/lib/niches-cache";
import { initialLeads } from "@/server/initial-data";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage({ searchParams }: PageProps<"/leads">) {
  const profile = await requireProfile(["admin", "sales"]); // authorize before reading the company's niche cache
  // Started now, not awaited: the first page of leads streams in while the niches load.
  const initial = initialLeads(profile, await searchParams);
  const niches = await getCachedNicheOptions(profile.company.id).catch(() => []);
  return <LeadsView initialNiches={niches} initial={initial} />;
}
