import type { Metadata } from "next";
import { AutomationView } from "@/components/automation/automation-view";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Automation" };

export default async function AutomationPage() {
  await requireProfile(["admin"]);
  return <AutomationView />;
}
