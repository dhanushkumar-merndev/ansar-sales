import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { companyLogoUrl } from "../../src/lib/companies";
import { isLibraryObjectPath, isLogoMime, LIBRARY_FILE_RE, LIBRARY_THUMB_RE, LOGO_PATH_RE, storageKey } from "../../src/lib/storage-paths";

const id = () => randomUUID();

describe("Tigris object names", () => {
  it("prefixes database paths with their bucket", () => {
    expect(storageKey("library", "a/b.pdf")).toBe("library/a/b.pdf");
    expect(storageKey("logos", "c/d.png")).toBe("logos/c/d.png");
  });

  it("accepts only library files and previews for signing", () => {
    const folder = id();
    expect(isLibraryObjectPath(`${folder}/${id()}.pdf`)).toBe(true);
    expect(isLibraryObjectPath(`${folder}/thumbs/${id()}.webp`)).toBe(true);
    expect(LIBRARY_FILE_RE.test(`${folder}/thumbs/${id()}.webp`)).toBe(false);
    expect(LIBRARY_THUMB_RE.test(`${folder}/thumbs/${id()}.png`)).toBe(false);
    for (const bad of [`../${id()}.pdf`, `${folder}/${id()}.exe`, `${folder}/../logos/${id()}.png`, `/${folder}/${id()}.pdf`, `${folder}/${id()}.pdf?x=1`, ""]) {
      expect(isLibraryObjectPath(bad)).toBe(false);
    }
  });

  it("keeps the public logo route to logo-shaped paths", () => {
    expect(LOGO_PATH_RE.test(`${id()}/${id()}.png`)).toBe(true);
    expect(LOGO_PATH_RE.test(`${id()}/${id()}.pdf`)).toBe(false);
    expect(LOGO_PATH_RE.test(`${id()}/thumbs/${id()}.webp`)).toBe(false);
    expect(isLogoMime("image/webp")).toBe(true);
    expect(isLogoMime("image/svg+xml")).toBe(false);
  });

  it("serves logos through the app's /logo route", () => {
    const p = `${id()}/${id()}.png`;
    expect(companyLogoUrl(p)).toBe(`/logo/${p}`);
    expect(companyLogoUrl(null)).toBeNull();
  });
});
