import type { Metadata } from "next";
import { DeletedClientsView } from "@/components/ads/deleted-clients-view";
import { requireSuperAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Deleted clients" };

export default async function DeletedClientsPage() {
  await requireSuperAdmin();
  return <DeletedClientsView />;
}
