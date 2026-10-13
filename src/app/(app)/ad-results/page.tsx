import type { Metadata } from "next";
import { AdResultsView } from "@/components/ads/portal-view";
import { requireFeature } from "@/lib/auth";

export const metadata: Metadata = { title: "Ad results" };

/** Inside an ads client's CRM: that client's ad results, read-only (the database scopes them to the CRM). */
export default async function AdResultsPage() {
  await requireFeature("client_workspace", ["admin", "sales"]);
  return <AdResultsView />;
}
