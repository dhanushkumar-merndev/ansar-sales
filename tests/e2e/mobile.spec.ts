import type { Page } from "@playwright/test";
import { storageState } from "./support/accounts";
import { createLead, phone, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { userClient } from "./support/supabase";
import { createNiche, dialog, toast } from "./support/ui";

test.use({ storageState: storageState("salesA"), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

test.describe("Mobile (390 px)", () => {
  test("LEAD-20 leads render as cards, filters open in a sheet, no sideways scrolling", async ({ page }) => {
    const t = tag();
    await createLead(userClient("salesA"), { name: `${t} Mobile` });
    await page.goto(`/leads?q=${encodeURIComponent(t)}`);
    await expect(page.getByRole("link", { name: new RegExp(`${t} Mobile`) })).toBeVisible();
    await expect(page.locator("table")).toBeHidden();
    await noHorizontalScroll(page);

    await page.getByRole("button", { name: /^Filters/ }).click();
    await expect(page.getByRole("dialog", { name: "Filters" })).toBeVisible();
  });

  test("the Add lead form is usable on a phone", async ({ page }) => {
    const t = tag();
    await page.goto("/leads");
    await page.getByRole("button", { name: "Add lead" }).first().click();
    const d = dialog(page, "Add lead");
    for (const id of ["#lead-name", "#lead-phone", "#lead-email", "#lead-niche"]) {
      const box = (await d.locator(id).boundingBox())!;
      expect(box.x, id).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, id).toBeLessThanOrEqual(390);
    }
    await d.locator("#lead-name").fill(`${t} Phone form`);
    await d.locator("#lead-phone").fill(phone().e164);
    await createNiche(page, d.locator("#lead-niche"), `${t} Niche`);
    await d.getByRole("button", { name: "Create lead" }).tap();
    await expect(toast(page, "Lead created")).toBeVisible();
  });

  test("lead detail fits the screen", async ({ page }) => {
    const t = tag();
    const { id } = await createLead(userClient("salesA"), { name: `${t} Detail`, note: "A fairly long note ".repeat(20) });
    await page.goto(`/leads/${id}`);
    await expect(page.getByRole("heading", { name: `${t} Detail` })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save note" })).toBeVisible();
    await noHorizontalScroll(page);
  });
});
