import type { Metadata } from "next";
import { AdsView, type AdsViewStart } from "@/components/ads/ads-view";
import { requireAds } from "@/lib/auth";

export const metadata: Metadata = { title: "Ads" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AdsPage({ searchParams }: PageProps<"/ads">) {
  await requireAds(["admin", "ads_manager"]);
  // Opened from the Our company tab: that account and company, over the same days.
  const q = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const account = one(q.account), category = one(q.category), from = one(q.from), to = one(q.to);
  const start: AdsViewStart = {
    account: account && UUID_RE.test(account) ? account : undefined,
    category: category && (category === "none" || UUID_RE.test(category)) ? category : undefined,
    range: from && to && DAY_RE.test(from) && DAY_RE.test(to) && from <= to ? { from, to } : undefined,
  };
  return <AdsView start={start} />;
}
