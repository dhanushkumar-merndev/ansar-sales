import type { Metadata } from "next";
import { FollowUpsView } from "@/components/follow-ups/follow-ups-view";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Follow-ups" };

export default async function FollowUpsPage() {
  await requireProfile(["admin", "sales"]);
  return <FollowUpsView />;
}
