import type { Metadata } from "next";
import { ProjectsView } from "@/components/projects/projects-view";
import { requireFeature } from "@/lib/auth";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage() {
  await requireFeature("projects", ["admin", "architect_manager", "landscape_designer", "execution", "account"]);
  return <ProjectsView />;
}
