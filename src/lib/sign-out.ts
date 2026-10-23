"use client";

import { signOut } from "@/server/actions/auth";

/**
 * Signs out, then loads the login page fresh (not a client-side navigation): the pages Next keeps mounted
 * but hidden (up to 3), the browser's page cache, kept query results and Realtime channels all belong to
 * the person who just left, and the next person to sign in on this tab must not see any of them.
 */
export async function signOutAndReload() {
  await signOut();
  window.location.replace("/login");
}
