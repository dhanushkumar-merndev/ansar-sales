import type { Metadata } from "next";
import { NichesAdmin } from "@/components/leads/niches-admin";
import { requireProfile } from "@/lib/auth";
import { getCachedNicheOptions } from "@/lib/niches-cache";

export const metadata: Metadata = { title: "Niches" };

export default async function NichesPage() {
  const { company } = await requireProfile(["admin"]);
  const niches = await getCachedNicheOptions(company.id).catch(() => []);
  return <NichesAdmin initialNiches={niches} />;
}
