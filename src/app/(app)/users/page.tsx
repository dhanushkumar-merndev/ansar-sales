import type { Metadata } from "next";
import { UsersView } from "@/components/users/users-view";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  await requireProfile(["admin"]);
  return <UsersView />;
}
