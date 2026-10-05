import type { Metadata } from "next";
import { NichesAdmin } from "@/components/leads/niches-admin";
import { requireProfile } from "@/lib/auth";
import { getCachedNicheOptions } from "@/lib/niches-cache";

export const metadata: Metadata = { title: "Niches" };

export default async function NichesPage() {
  await requireProfile(["admin"]);
  const niches = await getCachedNicheOptions().catch(() => []);
  return <NichesAdmin initialNiches={niches} />;
}
