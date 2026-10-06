import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdsClientDetail } from "@/components/ads/ads-client-detail";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Ads client" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdsClientPage({ params }: PageProps<"/ads/clients/[id]">) {
  await requireProfile(["admin", "ads_manager"]);
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  return <AdsClientDetail id={id} />;
}
