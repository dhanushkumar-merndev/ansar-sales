import type { Page, Request } from "@playwright/test";
import { storageState } from "./support/accounts";
import { createLead, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { userClient } from "./support/supabase";

test.use({ storageState: storageState("salesA") });

function track(page: Page) {
  const rest: Request[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/rest/v1/")) rest.push(r);
  });
  const lists = () => rest.filter((r) => r.url().includes("/rpc/list_leads"));
  return { rest, lists };
}

test.describe("Production hardening and request efficiency", () => {
  test("PROD-01/03 security headers on public and signed-in pages; no X-Powered-By", async ({ page, request }) => {
    const check = (h: Record<string, string>, label: string) => {
      expect(h["x-frame-options"], label).toBe("DENY");
      expect(h["content-security-policy"], label).toContain("frame-ancestors 'none'");
      expect(h["x-content-type-options"], label).toBe("nosniff");
      expect(h["referrer-policy"], label).toBe("strict-origin-when-cross-origin");
      expect(h["permissions-policy"], label).toContain("camera=()");
      expect(h["strict-transport-security"], label).toMatch(/max-age=\d+/);
      expect(h["x-powered-by"], label).toBeUndefined();
    };
    check((await request.get("/login")).headers(), "/login");
    const res = await page.goto("/leads");
    check(res!.headers(), "/leads");
  });

  test("PROD-02 manifest and robots are not hidden behind the login redirect", async ({ playwright, baseURL }) => {
    const anon = await playwright.request.newContext({ baseURL });
    const manifest = await anon.get("/site.webmanifest", { maxRedirects: 0 });
    expect(manifest.status()).toBe(200);
    expect(await manifest.json()).toHaveProperty("name");
    expect((await anon.get("/robots.txt", { maxRedirects: 0 })).status()).not.toBe(307);
    await anon.dispose();
  });

  test("PROD-05 the leads page loads with one bounded list request (no N+1)", async ({ page }) => {
    const { rest, lists } = track(page);
    await page.goto("/leads");
    await expect(page.getByRole("heading", { name: "Leads", level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(lists()).toHaveLength(1);
    expect(lists()[0].postDataJSON()).toMatchObject({ p_limit: 20, p_offset: 0 });
    expect(rest.filter((r) => /\/rest\/v1\/(follow_ups|profiles|niches|lead_activities)/.test(r.url()))).toHaveLength(0);
  });

  test("LEAD-17 search is debounced: one request after a burst of typing", async ({ page }) => {
    const t = tag();
    await createLead(userClient("salesA"), { name: `${t} Debounce` });
    const { lists } = track(page);
    await page.goto("/leads");
    await page.waitForLoadState("networkidle");
    const before = lists().length;

    await page.getByLabel("Search leads").pressSequentially(t, { delay: 40 });
    await expect(page.getByRole("link", { name: `${t} Debounce` })).toBeVisible();
    await page.waitForTimeout(800);
    const typed = lists().slice(before);
    expect(typed).toHaveLength(1);
    expect(typed[0].postDataJSON().p_search).toBe(t);
  });

  test("a slow, superseded search response never overwrites the newest results", async ({ page }) => {
    const t = tag();
    await createLead(userClient("salesA"), { name: `${t} Newest` });
    const stale = `${t} stale-term`;
    await page.route("**/rest/v1/rpc/list_leads", async (route) => {
      if (route.request().postDataJSON()?.p_search === stale) await new Promise((r) => setTimeout(r, 2_500));
      await route.continue().catch(() => {}); // the app aborts the superseded request
    });
    await page.goto("/leads");
    const search = page.getByLabel("Search leads");
    await search.fill(stale);
    await page.waitForTimeout(500); // debounce elapsed, slow request in flight
    await search.fill(t);
    await expect(page.getByRole("link", { name: `${t} Newest` })).toBeVisible();
    await page.waitForTimeout(3_000); // let the slow response arrive
    await expect(page.getByRole("link", { name: `${t} Newest` })).toBeVisible();
    await expect(page.getByText("No leads match")).toHaveCount(0);
  });
});
