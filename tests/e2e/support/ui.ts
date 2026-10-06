import { type BrowserContext, expect, type Locator, type Page } from "@playwright/test";

/** Hides the Next.js dev-mode indicator, which sits over the sidebar footer and intercepts clicks. */
export async function hideDevOverlay(context: BrowserContext) {
  await context.addInitScript(() => {
    const hide = () => document.querySelectorAll<HTMLElement>("nextjs-portal").forEach((el) => el.style.setProperty("display", "none", "important"));
    new MutationObserver(hide).observe(document, { childList: true, subtree: true });
  });
}

export async function signIn(page: Page, username: string, password: string, path = "/login") {
  await page.goto(path);
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
}

/** The app's own form error (Next.js also renders an empty role="alert" route announcer). */
export const formAlert = (page: Page) => page.locator('p[role="alert"]');

export async function expectRateLimitNotHit(page: Page) {
  const alert = formAlert(page);
  if (await alert.isVisible().catch(() => false)) {
    const text = await alert.textContent();
    if (text?.includes("Too many attempts")) throw new Error("Supabase sign-in rate limit hit: wait 5 minutes before re-running the E2E suite.");
  }
}

/** Sonner toast with the given text. */
export const toast = (page: Page, text: string | RegExp) => page.locator("[data-sonner-toast]").filter({ hasText: text }).first();

/** The value element of a dashboard/finance summary card, located by its label. */
export function stat(page: Page, label: string): Locator {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('[data-slot="card-description"]', { hasText: new RegExp(`^${escapeRe(label)}$`) }) })
    .locator('[data-slot="card-title"]')
    .filter({ visible: true }); // streamed RSC chunks briefly hold a hidden copy of the card
}

export async function readCount(page: Page, label: string) {
  const el = stat(page, label);
  await expect(el).toHaveText(/\d/);
  return Number((await el.textContent())!.replace(/[^\d]/g, ""));
}

/** "₹1,23,456.78" → 12345678 (paise), exact. */
export function paise(text: string) {
  const clean = text.replace(/[^\d.-]/g, "");
  const [rupees, frac = ""] = clean.replace("-", "").split(".");
  const value = Number(rupees) * 100 + Number((frac + "00").slice(0, 2));
  return clean.startsWith("-") ? -value : value;
}

export async function readINR(page: Page, label: string) {
  const el = stat(page, label);
  await expect(el).toHaveText(/₹/);
  return paise((await el.textContent())!);
}

export async function selectOption(page: Page, trigger: Locator, option: string | RegExp) {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

/** Opens the niche combobox and creates a new niche from the typed label. */
export async function createNiche(page: Page, trigger: Locator, label: string) {
  await trigger.click();
  await page.getByPlaceholder("Search niches…").fill(label);
  await page.getByRole("option", { name: /^Create/ }).click();
}

export async function chooseNiche(page: Page, trigger: Locator, label: string) {
  await trigger.click();
  await page.getByPlaceholder("Search niches…").fill(label);
  await page.getByRole("option", { name: label, exact: true }).click();
}

/** Dialog by its title. */
export const dialog = (page: Page, title: string | RegExp) => page.getByRole("dialog", { name: title });

/** A timeline entry ("<actor> <title>") inside the lead Activity card. */
export const timelineItems = (page: Page) =>
  page.locator('[data-slot="card"]').filter({ has: page.getByText("Activity", { exact: true }) }).locator("ol > li");

/**
 * Waits until an open page's Realtime channel reports Live, plus a short settle: Supabase confirms the
 * channel join before the postgres_changes listener is ready, and events in that gap are only caught
 * by the focus/poll fallback.
 */
export async function waitForLive(page: Page) {
  await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2_500);
}

/** Simulates the tab regaining focus (the app refetches active lists on focus). */
export async function refocus(page: Page) {
  await page.waitForTimeout(2_100); // focus refetch is throttled to one per 2 s
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
