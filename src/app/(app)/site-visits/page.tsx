import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { SiteVisitsList } from "@/components/projects/site-visits/site-visits-list";
import { requireFeature } from "@/lib/auth";

export const metadata: Metadata = { title: "Site visits" };

export default async function SiteVisitsPage() {
  const profile = await requireFeature("projects", ["admin", "sales", "architect_manager", "landscape_designer"]);
  return (
    <>
      <PageHeader title="Site visits" description="Visits planned for leads and projects. Open one on site to check in with your location." />
      <SiteVisitsList defaultMine={!profile.roles.includes("admin")} />
    </>
  );
}
