import type { Metadata } from "next";
import { AdsClientsView } from "@/components/ads/ads-clients-view";
import { requireAds } from "@/lib/auth";

export const metadata: Metadata = { title: "Ads clients" };

export default async function AdsClientsPage() {
  await requireAds(["admin", "ads_manager"]);
  return <AdsClientsView />;
}
