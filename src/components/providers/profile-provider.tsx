"use client";

import { createContext, use } from "react";
import type { CompanyBrand } from "@/lib/companies";
import type { AppRole } from "@/lib/constants";

export type ClientProfile = {
  id: string;
  username: string;
  display_name: string;
  /** Effective role in the current company (a super admin is "admin"). */
  role: AppRole;
  isSuperAdmin: boolean;
  company: CompanyBrand;
  /** Switchable companies (super admin: all; ads manager: assigned ones). */
  companies: CompanyBrand[];
};

const ProfileContext = createContext<Promise<ClientProfile> | null>(null);

/** Display-only copy of the current profile. Authorization is always re-checked on the server and by RLS. */
export function ProfileProvider({ profile, children }: { profile: Promise<ClientProfile>; children: React.ReactNode }) {
  return <ProfileContext.Provider value={profile}>{children}</ProfileContext.Provider>;
}

/** Suspends until the session read resolves; call it inside a Suspense boundary. */
export function useProfile() {
  const promise = use(ProfileContext);
  if (!promise) throw new Error("useProfile must be used inside ProfileProvider");
  return use(promise);
}
