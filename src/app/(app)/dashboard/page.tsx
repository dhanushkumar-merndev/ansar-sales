import type { Metadata } from "next";
import { AdminDashboard, FinanceDashboard, SalesDashboard } from "@/components/dashboard/dashboards";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const profile = await requireProfile();
  if (profile.role === "admin") return <AdminDashboard />;
  if (profile.role === "sales") return <SalesDashboard />;
  return <FinanceDashboard />;
}
