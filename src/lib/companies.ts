export type CompanyBrand = { id: string; name: string; brandHighlight: string | null; logoUrl: string | null };

/**
 * Logos are in the private Tigris bucket; /logo/<path> redirects to a short-lived signed URL.
 * Logos are not sensitive, so that route needs no session and works on public share pages too.
 */
export function companyLogoUrl(path: string | null | undefined) {
  return path ? `/logo/${path}` : null;
}

export function toCompanyBrand(c: { id: string; name: string; brand_highlight: string | null; logo_path: string | null }): CompanyBrand {
  return { id: c.id, name: c.name, brandHighlight: c.brand_highlight, logoUrl: companyLogoUrl(c.logo_path) };
}
