import type { Metadata } from "next";
import { SettingsView } from "@/components/settings/settings-view";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireProfile();
  return <SettingsView />;
}
