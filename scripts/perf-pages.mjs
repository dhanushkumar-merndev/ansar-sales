#!/usr/bin/env node
// Times Dashboard, Leads, Follow-ups and a lead page in a real browser, signed in as a perf_* user.
// Usage: node scripts/perf-pages.mjs --logins <file from perf:sandbox> --base <app URL> [--user admin|salesA] [--runs 3] [--only Dashboard,Leads]
//
// Measures, per page: a full load (until no skeleton is left and data is shown) and a sidebar
// navigation from another page. Read-only apart from signing in.
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

/** Data is on screen: the page's marker text is shown and no skeleton is left (checked every frame). */
async function ready(marker) {
  try {
    await page.waitForFunction((m) => document.body.textContent.includes(m)
      && document.querySelectorAll('[data-slot="sidebar-inset"] [data-slot="skeleton"]').length === 0, marker, { timeout: 30_000, polling: "raf" });
  } catch (e) {
    throw new Error(`"${marker}" not shown (or still loading) on ${page.url()}`, { cause: e });
  }
}

const { data: leadHref } = { data: await (async () => {
  await page.goto(new URL("/leads", values.base).href);
  await ready("[PERF] Lead");
  return page.locator('a[href^="/leads/"]').filter({ hasText: "[PERF] Lead" }).first().getAttribute("href");
})() };

const PAGES = [
  { name: "Dashboard", path: "/dashboard", nav: "Dashboard", marker: values.user === "admin" ? "Top niches" : "My pipeline" },
  { name: "Leads", path: "/leads", nav: "Leads", marker: "[PERF] Lead" },
  // The sidebar opens the Today tab, which has no perf tasks: wait for its heading instead.
  { name: "Follow-ups", path: "/follow-ups?view=upcoming", nav: "Follow-ups", marker: "[PERF] Lead", navMarker: "No follow-ups" },
  { name: "Lead page", path: leadHref, marker: "Timeline" },
];

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`${values.base} as ${u.username}`);
console.log("page          full load   requests   sidebar nav   (median of runs, ms)");
for (const p of PAGES.filter((x) => !values.only || values.only.split(",").includes(x.name))) {
  const full = [];
  const nav = [];
  let reqs = 0;
  for (let i = 0; i < RUNS; i++) {
    requests = 0;
    const t = Date.now();
    await page.goto(new URL(p.path, values.base).href);
    await ready(p.marker);
    full.push(Date.now() - t);
    reqs = requests;
    if (p.nav) {
      // Navigate away and back through the sidebar, the way staff move around.
      await page.goto(new URL("/settings", values.base).href);
      await page.getByRole("heading", { level: 1 }).first().waitFor();
      await page.waitForLoadState("networkidle"); // hydrated, so the click is a client-side navigation
      const t2 = Date.now();
      await page.locator('[data-slot="sidebar"]').getByRole("link", { name: p.nav, exact: true }).first().click();
      await page.waitForURL((url) => url.pathname === new URL(p.path, values.base).pathname);
      await ready(p.navMarker ?? p.marker);
      nav.push(Date.now() - t2);
    }
  }
  console.log(`${p.name.padEnd(13)} ${String(median(full)).padStart(9)}   ${String(reqs).padStart(8)}   ${nav.length ? String(median(nav)).padStart(11) : "          -"}`);
}
await browser.close();
