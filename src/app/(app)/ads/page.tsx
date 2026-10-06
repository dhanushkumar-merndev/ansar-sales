import type { Metadata } from "next";
import { AdsView } from "@/components/ads/ads-view";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Ads" };

export default async function AdsPage() {
  await requireProfile(["admin", "ads_manager"]);
  return <AdsView />;
}
