import type { Metadata } from "next";
import { MyWorkView } from "@/components/projects/my-work-view";
import { requireFeature } from "@/lib/auth";

export const metadata: Metadata = { title: "My work" };

export default async function MyWorkPage() {
  await requireFeature("projects", ["architect_manager", "landscape_designer", "execution", "admin"]);
  return <MyWorkView />;
}
