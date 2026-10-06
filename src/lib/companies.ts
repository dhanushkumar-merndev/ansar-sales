import { publicEnv } from "@/lib/env";

export const COMPANY_LOGO_BUCKET = "company-logos";

export type CompanyBrand = { id: string; name: string; brandHighlight: string | null; logoUrl: string | null };

/** Logos live in a public bucket (they are not sensitive), so a plain URL works everywhere, including share pages. */
export function companyLogoUrl(path: string | null | undefined) {
  return path ? `${publicEnv.supabaseUrl}/storage/v1/object/public/${COMPANY_LOGO_BUCKET}/${path}` : null;
}

export function toCompanyBrand(c: { id: string; name: string; brand_highlight: string | null; logo_path: string | null }): CompanyBrand {
  return { id: c.id, name: c.name, brandHighlight: c.brand_highlight, logoUrl: companyLogoUrl(c.logo_path) };
}
