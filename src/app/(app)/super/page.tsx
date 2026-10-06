import type { Metadata } from "next";
import { SuperSettingsView } from "@/components/super/super-settings-view";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Super settings" };

export default async function SuperSettingsPage() {
  await requireSuperAdmin();
  return <SuperSettingsView />;
}
