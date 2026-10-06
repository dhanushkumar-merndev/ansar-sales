import type { Metadata } from "next";
import { ReportsView } from "@/components/reports/reports-view";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  await requireProfile();
  return <ReportsView />;
}
