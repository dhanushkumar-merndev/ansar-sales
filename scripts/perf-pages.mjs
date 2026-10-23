#!/usr/bin/env node
// Times Dashboard, Leads, Follow-ups and a lead page in a real browser, signed in as a perf_* user.
// Usage: node scripts/perf-pages.mjs --logins <file from perf:sandbox> --base <app URL> [--user admin|salesA] [--runs 3] [--only Dashboard,Leads]
//
// Measures, per page: a full load (until no skeleton is left and data is shown), a sidebar navigation
// from a freshly loaded page (plain click, and after hovering the link like a mouse user), and a return
// to the page through the sidebar a few seconds after leaving it. For the lead page: a click on a lead
// in the list, plain and after hovering. Read-only apart from signing in.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values } = parseArgs({
  options: { logins: { type: "string" }, base: { type: "string" }, user: { type: "string", default: "admin" }, runs: { type: "string", default: "3" }, only: { type: "string" } },
});
if (!values.logins || !values.base) {
  console.error("Needs --logins <file> and --base <app URL>.");
  process.exit(1);
}
const u = JSON.parse(readFileSync(values.logins, "utf8")).users[values.user];
const RUNS = Number(values.runs);
const HOVER_MS = 150;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
let requests = 0;
page.on("request", (r) => {
  if (/\/rest\/v1\/|\/auth\/v1\/|_rsc=|\/(leads|follow-ups|dashboard)/.test(r.url())) requests++;
});

await page.goto(new URL("/login", values.base).href);
await page.locator("#username").fill(u.username);
await page.locator("#password").fill(u.password);
await page.getByRole("button", { name: "Continue" }).click();
await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });

/**
 * Data is on screen: the page's marker text is visible and no visible skeleton is left (checked every frame).
 * Visible only: Next keeps up to 3 earlier pages hidden in the document, with their text and skeletons.
 */
async function ready(marker) {
  try {
    await page.waitForFunction((m) => {
      const main = document.querySelector('[data-slot="sidebar-inset"]');
      if (!main || !main.innerText.includes(m)) return false;
      return [...main.querySelectorAll('[data-slot="skeleton"]')].every((s) => !s.checkVisibility());
    }, marker, { timeout: 30_000, polling: "raf" });
  } catch (e) {
    throw new Error(`"${marker}" not shown (or still loading) on ${page.url()}`, { cause: e });
  }
}

const sidebarLink = (name) => page.locator('[data-slot="sidebar"]').getByRole("link", { name, exact: true }).first();

/** Fresh load of /settings, hydrated, so the next click is a client-side navigation with an empty page cache. */
async function freshSettings() {
  await page.goto(new URL("/settings", values.base).href);
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.waitForLoadState("networkidle");
}

/** Clicks (after hovering for HOVER_MS when asked) and returns ms from the click until the page is ready. */
async function clickTimed(link, path, marker, hover) {
  if (hover) {
    await link.hover();
    await page.waitForTimeout(HOVER_MS);
  }
  const t = Date.now();
  await link.click();
  await page.waitForURL((url) => url.pathname === new URL(path, values.base).pathname);
  await ready(marker);
  return Date.now() - t;
}

const leadHref = await (async () => {
  await page.goto(new URL("/leads", values.base).href);
  await ready("[PERF] Lead");
  return page.locator('a[href^="/leads/"]').filter({ hasText: "[PERF] Lead" }).first().getAttribute("href");
})();

const PAGES = [
  { name: "Dashboard", path: "/dashboard", nav: "Dashboard", marker: values.user === "admin" ? "Top niches" : "My pipeline", via: "Leads" },
  { name: "Leads", path: "/leads", nav: "Leads", marker: "[PERF] Lead", via: "Dashboard" },
  // The sidebar opens the Today tab, which has no perf tasks: wait for its heading instead.
  { name: "Follow-ups", path: "/follow-ups?view=upcoming", nav: "Follow-ups", marker: "[PERF] Lead", navMarker: "No follow-ups", via: "Leads" },
  { name: "Lead page", path: leadHref, marker: "Timeline" },
];
const MARKERS = Object.fromEntries(PAGES.filter((p) => p.nav).map((p) => [p.nav, { path: p.path, marker: p.navMarker ?? p.marker }]));

const median = (xs) => (xs.length ? String([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]) : "-");
console.log(`${values.base} as ${u.username}`);
console.log("page          full load   requests   click   hover+click   return   (median of runs, ms)");
for (const p of PAGES.filter((x) => !values.only || values.only.split(",").includes(x.name))) {
  const full = [];
  const click = [];
  const hoverClick = [];
  const back = [];
  let reqs = 0;
  for (let i = 0; i < RUNS; i++) {
    requests = 0;
    const t = Date.now();
    await page.goto(new URL(p.path, values.base).href);
    await ready(p.marker);
    full.push(Date.now() - t);
    reqs = requests;
    if (p.nav) {
      const marker = p.navMarker ?? p.marker;
      await freshSettings();
      click.push(await clickTimed(sidebarLink(p.nav), p.path, marker, false));
      await freshSettings();
      hoverClick.push(await clickTimed(sidebarLink(p.nav), p.path, marker, true));
      // Leave through the sidebar and come back a few seconds later, the way staff move around.
      await clickTimed(sidebarLink(p.via), MARKERS[p.via].path, MARKERS[p.via].marker, false);
      await page.waitForTimeout(3000);
      back.push(await clickTimed(sidebarLink(p.nav), p.path, marker, false));
    } else {
      // The lead page: opened from the list by its name.
      for (const hover of [false, true]) {
        await page.goto(new URL("/leads", values.base).href);
        await ready("[PERF] Lead");
        await page.waitForLoadState("networkidle");
        const link = page.locator(`a[href="${p.path}"]`).first();
        (hover ? hoverClick : click).push(await clickTimed(link, p.path, p.marker, hover));
      }
    }
  }
  console.log(`${p.name.padEnd(13)} ${median(full).padStart(9)}   ${String(reqs).padStart(8)}   ${median(click).padStart(5)}   ${median(hoverClick).padStart(11)}   ${median(back).padStart(6)}`);
}
await browser.close();
