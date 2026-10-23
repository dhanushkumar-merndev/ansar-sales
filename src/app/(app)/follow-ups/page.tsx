import type { Metadata } from "next";
import { FollowUpsView } from "@/components/follow-ups/follow-ups-view";
import { requireProfile } from "@/lib/auth";
import { initialFollowUps } from "@/server/initial-data";

export const metadata: Metadata = { title: "Follow-ups" };

export default async function FollowUpsPage({ searchParams }: PageProps<"/follow-ups">) {
  const profile = await requireProfile(["admin", "sales"]);
  return <FollowUpsView initial={initialFollowUps(profile, await searchParams)} />;
}
