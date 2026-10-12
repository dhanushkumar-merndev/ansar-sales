import type { Metadata } from "next";
import { NotificationsView } from "@/components/notifications/notifications-view";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  await requireProfile();
  return <NotificationsView />;
}
