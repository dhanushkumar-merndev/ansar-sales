import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FinancePeriodView } from "@/components/finance/finance-period-view";
import { requireProfile } from "@/lib/auth";
import { parsePeriod } from "@/lib/time";

export const metadata: Metadata = { title: "Finance report" };

export default async function FinancePeriodPage({ params }: PageProps<"/finance/[period]">) {
  await requireProfile(["admin", "account"]);
  const { period } = await params;
  if (!parsePeriod(period)) notFound();
  return <FinancePeriodView periodKey={period} />;
}
