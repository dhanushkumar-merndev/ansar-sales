import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AdminDashboard, FinanceDashboard, SalesDashboard } from "@/components/dashboard/dashboards";
import { ProjectsDashboard } from "@/components/projects/projects-dashboard";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const profile = await requireProfile();
  if (profile.role === "admin") {
    // Companies with the projects module (Star Gardens) see their projects first.
    if (profile.features.includes("projects")) {
      return (
        <div className="space-y-8">
          <ProjectsDashboard />
          <AdminDashboard />
        </div>
      );
    }
    return <AdminDashboard />;
  }
  if (profile.role === "sales") return <SalesDashboard />;
  if (profile.roles.includes("account")) return <FinanceDashboard />;
  redirect(profile.role === "ads_manager" ? "/ads" : "/projects");
}
