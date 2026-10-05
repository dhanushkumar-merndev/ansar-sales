import type { Metadata } from "next";
import { FinanceView } from "@/components/finance/finance-view";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Finance" };

export default async function FinancePage() {
  await requireProfile(["admin", "account"]);
  return <FinanceView />;
}
