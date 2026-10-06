import type { Metadata } from "next";
import { LibraryView } from "@/components/library/library-view";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Library" };

export default async function LibraryPage() {
  await requireProfile(["admin", "sales"]);
  return <LibraryView />;
}
