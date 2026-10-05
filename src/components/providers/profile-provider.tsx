"use client";

import { createContext, useContext } from "react";
import type { AppRole } from "@/lib/constants";

export type ClientProfile = { id: string; username: string; display_name: string; role: AppRole };

const ProfileContext = createContext<ClientProfile | null>(null);

/** Display-only copy of the current profile. Authorization is always re-checked on the server and by RLS. */
export function ProfileProvider({ profile, children }: { profile: ClientProfile; children: React.ReactNode }) {
  return <ProfileContext.Provider value={profile}>{children}</ProfileContext.Provider>;
}

export function useProfile() {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile must be used inside ProfileProvider");
  return ctx;
}
