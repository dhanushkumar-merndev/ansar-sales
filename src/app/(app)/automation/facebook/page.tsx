import type { Metadata } from "next";
import { LeadAdsInsights } from "@/components/automation/lead-ads-insights";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Facebook Lead Ads insights" };

export default async function LeadAdsInsightsPage() {
  await requireProfile(["admin"]);
  return <LeadAdsInsights />;
}
