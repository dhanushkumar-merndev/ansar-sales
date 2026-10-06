import type { Metadata } from "next";
import { PortalView } from "@/components/ads/portal-view";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Your ad results" };

/** Ads clients' read-only portal; every other role is sent to its own home page. */
export default async function PortalPage() {
  await requireProfile(["client"]);
  return <PortalView />;
}
