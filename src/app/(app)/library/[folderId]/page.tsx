import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FolderView } from "@/components/library/folder-view";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Library" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LibraryFolderPage({ params }: PageProps<"/library/[folderId]">) {
  await requireProfile(["admin", "sales"]);
  const { folderId } = await params;
  if (!UUID_RE.test(folderId)) notFound();
  return <FolderView folderId={folderId} />;
}
