import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminDashboard, type AdminData, FinanceDashboard, SalesDashboard, type SalesData } from "@/components/dashboard/dashboards";
import { ProjectsDashboard } from "@/components/projects/projects-dashboard";
import { requireProfile } from "@/lib/auth";
import { initialDashboard } from "@/server/initial-data";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const profile = await requireProfile();
  // The first reads start here and stream in with the page (not awaited).
  if (profile.role === "admin") {
    const initial = initialDashboard<AdminData>(profile, "admin");
    // Companies with the projects module (Star Gardens) see their projects first.
    if (profile.features.includes("projects")) {
      return (
        <div className="space-y-8">
          <ProjectsDashboard />
          <AdminDashboard initial={initial} />
        </div>
      );
    }
    return <AdminDashboard initial={initial} />;
  }
  // Only the dashboard itself: also waiting for the two task cards here made opening it slower.
  if (profile.role === "sales") return <SalesDashboard initial={initialDashboard<SalesData>(profile, "sales")} />;
  if (profile.roles.includes("account")) return <FinanceDashboard />;
  redirect(profile.role === "ads_manager" ? "/ads" : "/projects");
}
