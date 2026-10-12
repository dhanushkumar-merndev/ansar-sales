import type { Metadata } from "next";
import { TeamWorkView } from "@/components/projects/team-work-view";
import { requireFeature } from "@/lib/auth";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  await requireFeature("projects", ["admin", "architect_manager"]);
  return <TeamWorkView />;
}
