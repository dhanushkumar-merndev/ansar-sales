import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProjectDetailView } from "@/components/projects/project-detail-view";
import { requireFeature } from "@/lib/auth";

export const metadata: Metadata = { title: "Project" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  await requireFeature("projects", ["admin", "architect_manager", "landscape_designer", "execution", "account"]);
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  return <ProjectDetailView projectId={id} />;
}
