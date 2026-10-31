import type { Metadata } from "next";
import { SettingsView } from "@/components/settings/settings-view";
import { requireProfile } from "@/lib/auth";
import { whatsappNumber } from "@/lib/env";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireProfile();
  // The CRM's WhatsApp number (not secret: staff send it a message to link). Null hides WhatsApp.
  return <SettingsView whatsappNumber={whatsappNumber()} />;
}
