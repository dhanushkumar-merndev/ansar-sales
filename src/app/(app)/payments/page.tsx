import type { Metadata } from "next";
import { PaymentsView } from "@/components/projects/payments/payments-view";
import { requireFeature } from "@/lib/auth";

export const metadata: Metadata = { title: "Payments" };

export default async function PaymentsPage() {
  await requireFeature("projects", ["admin", "account"]);
  return <PaymentsView />;
}
