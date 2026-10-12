import type { Metadata } from "next";
import { AutomationView } from "@/components/automation/automation-view";
import { requireAds } from "@/lib/auth";

export const metadata: Metadata = { title: "Automation" };

export default async function AutomationPage() {
  await requireAds(["admin"]);
  return <AutomationView />;
}
