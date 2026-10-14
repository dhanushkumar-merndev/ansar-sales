import type { Metadata } from "next";
import { AdsCompaniesView } from "@/components/ads/ads-companies-view";
import { requireAds } from "@/lib/auth";

export const metadata: Metadata = { title: "Ads · Our company" };
// "Sync leads" over 30 or 90 days can take a few minutes.
export const maxDuration = 300;

export default async function AdsCompaniesPage() {
  await requireAds(["admin", "ads_manager"]);
  return <AdsCompaniesView />;
}
