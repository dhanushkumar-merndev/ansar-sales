import type { Metadata } from "next";
import { LeadsView } from "@/components/leads/leads-view";
import { requireProfile } from "@/lib/auth";
import { getCachedNicheOptions } from "@/lib/niches-cache";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage() {
  await requireProfile(["admin", "sales"]); // authorize before reading the shared niche cache
  const niches = await getCachedNicheOptions().catch(() => []);
  return <LeadsView initialNiches={niches} />;
}
