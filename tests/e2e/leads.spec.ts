import type { Page, Request } from "@playwright/test";
import { readRun, storageState } from "./support/accounts";
import { createLead, phone, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { serviceClient, userClient } from "./support/supabase";
import { createNiche, dialog, selectOption, toast } from "./support/ui";

test.use({ storageState: storageState("salesA") });

const listRequests = (page: Page) => {
  const seen: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/rest/v1/rpc/list_leads")) seen.push(r);
  });
  return seen;
};
const body = (r: Request) => r.postDataJSON() as Record<string, unknown>;

async function openAddLead(page: Page) {
  await page.goto("/leads");
  await page.getByRole("button", { name: "Add lead" }).first().click();
  return dialog(page, "Add lead");
}

test.describe("Leads", () => {
  test("LEAD-02/03 required-field and format validation; nothing is saved", async ({ page }) => {
    const d = await openAddLead(page);
    await d.getByRole("button", { name: "Create lead" }).click();
    await expect(d.getByText("Name is required")).toBeVisible();
    await expect(d.getByText("Phone is required")).toBeVisible();
    await expect(d.getByText("Choose or create a niche")).toBeVisible();

    await d.locator("#lead-phone").fill("12345");
    await d.locator("#lead-email").fill("not-an-email");
    await d.getByRole("button", { name: "Create lead" }).click();
    await expect(d.getByText(/Enter a valid phone number/)).toBeVisible();
    await expect(d.getByText("Enter a valid email")).toBeVisible();
    await expect(d).toBeVisible();
  });

  test("LEAD-01/04 NICHE-01 sales creates a lead with a new niche and no email", async ({ page, run }) => {
    const t = tag();
    const local = phone().e164.replace("+91", ""); // typed as a local 10-digit number
    const d = await openAddLead(page);
    await d.locator("#lead-name").fill(`  ${t} Ravi  `);
    await d.locator("#lead-phone").fill(local);
    await createNiche(page, d.locator("#lead-niche"), `${t} Gyms`);
    await expect(d.locator("#lead-niche")).toContainText("(new)");

    // The niche is only persisted when the lead is saved.
    const before = await serviceClient().from("niches").select("id").eq("normalized_name", `${t} gyms`.toLowerCase());
    expect(before.data).toHaveLength(0);

    await d.getByRole("button", { name: "Create lead" }).click();
    await expect(toast(page, "Lead created")).toBeVisible();
    await expect(d).toBeHidden();

    const { data: lead } = await serviceClient()
      .from("leads")
      .select("name, phone, phone_normalized, email, status, owner_id, created_by, niche:niches!leads_niche_id_fkey(name)")
      .eq("name", `${t} Ravi`)
      .single();
    expect(lead).toMatchObject({ name: `${t} Ravi`, email: null, status: "new", owner_id: run.ids.salesA, created_by: run.ids.salesA, phone_normalized: `+91${local}` });
    expect(lead!.phone).toMatch(/^\+91 /);
    expect((lead as unknown as { niche: { name: string } }).niche.name).toBe(`${t} Gyms`);

    await page.getByLabel("Search leads").fill(t);
    await expect(page.getByRole("link", { name: `${t} Ravi` })).toBeVisible();
  });

  test("LEAD-06 duplicate of own lead links to it", async ({ page }) => {
    const t = tag();
    const p = phone();
    const { id } = await createLead(userClient("salesA"), { name: `${t} Existing`, phone: p });
    const d = await openAddLead(page);
    await d.locator("#lead-phone").fill(p.e164);
    await d.locator("#lead-name").click(); // blur triggers the duplicate check
    await expect(d.getByText("A lead with this phone already exists")).toBeVisible();
    await expect(d.getByRole("link", { name: "open it" })).toHaveAttribute("href", `/leads/${id}`);
  });

  test("LEAD-07 duplicate of another user's lead reveals nothing and can be saved deliberately", async ({ page }) => {
    const t = tag();
    const p = phone();
    await createLead(userClient("salesB"), { name: `${t} Secret B lead`, phone: p, email: "secret@example.com" });

    const d = await openAddLead(page);
    await d.locator("#lead-name").fill(`${t} Mine`);
    await d.locator("#lead-phone").fill(p.e164);
    await d.locator("#lead-name").click();
    await expect(d.getByText("(owned by another user)")).toBeVisible();
    await expect(d.getByRole("link", { name: "open it" })).toHaveCount(0);
    await expect(d).not.toContainText("Secret B lead");
    await expect(d).not.toContainText("secret@example.com");

    await createNiche(page, d.locator("#lead-niche"), `${t} Niche`);
    await d.getByRole("button", { name: "Create lead" }).click();
    await expect(d.getByText("This phone number already belongs to a lead owned by another user.")).toBeVisible();
    await expect(d.getByRole("button", { name: "Create lead" })).toBeDisabled();
    await d.getByRole("button", { name: "Save duplicate" }).click();
    await expect(toast(page, "Lead created")).toBeVisible();
  });

  test("LEAD-08 double-clicking Create saves exactly one lead", async ({ page }) => {
    const t = tag();
    const d = await openAddLead(page);
    await d.locator("#lead-name").fill(`${t} Once`);
    await d.locator("#lead-phone").fill(phone().e164);
    await createNiche(page, d.locator("#lead-niche"), `${t} Niche`);
    await d.getByRole("button", { name: "Create lead" }).dblclick();
    await expect(toast(page, "Lead created")).toBeVisible();
    await page.waitForTimeout(1_500);
    const { count } = await serviceClient().from("leads").select("id", { count: "exact", head: true }).eq("name", `${t} Once`);
    expect(count).toBe(1);
  });

  test("LEAD-11 search by name, email and phone digits; wildcards are literal", async ({ page }) => {
    const t = tag();
    const a = userClient("salesA");
    const pBeta = phone();
    const email = `alpha.${t.split(" ")[1]}@example.com`;
    await createLead(a, { name: `${t} Alpha`, email });
    await createLead(a, { name: `${t} Beta`, phone: pBeta });
    await page.goto("/leads");
    const search = page.getByLabel("Search leads");

    await search.fill(t);
    await expect(page.getByRole("link", { name: `${t} Alpha` })).toBeVisible();
    await expect(page.getByRole("link", { name: `${t} Beta` })).toBeVisible();

    await search.fill(email);
    await expect(page.getByRole("link", { name: `${t} Alpha` })).toBeVisible();
    await expect(page.getByRole("link", { name: `${t} Beta` })).toHaveCount(0);

    await search.fill(pBeta.e164.slice(-6));
    await expect(page.getByRole("link", { name: `${t} Beta` })).toBeVisible();

    await search.fill(`${t}%`);
    await expect(page.getByText("No leads match")).toBeVisible();
    await search.fill("%");
    await expect(page.getByText("No leads match")).toBeVisible();
  });

  test("LEAD-12 status filter is applied server-side and kept in the URL", async ({ page }) => {
    const t = tag();
    const a = userClient("salesA");
    await createLead(a, { name: `${t} Open` });
    await createLead(a, { name: `${t} Closed`, status: "won" });
    await page.goto(`/leads?q=${encodeURIComponent(t)}`);
    await expect(page.getByRole("link", { name: `${t} Open` })).toBeVisible();

    await selectOption(page, page.getByRole("combobox", { name: "Status" }), "Won");
    await expect(page).toHaveURL(/status=won/);
    await expect(page.getByRole("link", { name: `${t} Closed` })).toBeVisible();
    await expect(page.getByRole("link", { name: `${t} Open` })).toHaveCount(0);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByRole("link", { name: `${t} Open` })).toBeVisible();
  });

  test("LEAD-13/15/16 pagination, page size, sort and URL state across reload and Back", async ({ page }) => {
    const t = tag();
    const a = userClient("salesA");
    for (let i = 23; i >= 1; i--) await createLead(a, { name: `${t} P${String(i).padStart(2, "0")}` });

    await page.goto(`/leads?q=${encodeURIComponent(t)}&sort=name&dir=asc`);
    const names = page.locator("table tbody tr td:first-child a");
    await expect(page.getByText("1–20 of 23")).toBeVisible();
    await expect(names).toHaveCount(20);
    await expect(names.first()).toHaveText(`${t} P01`);

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByText("21–23 of 23")).toBeVisible();
    await expect(names).toHaveText([`${t} P21`, `${t} P22`, `${t} P23`]);

    await page.reload();
    await expect(page.getByText("21–23 of 23")).toBeVisible();
    await page.goBack();
    await expect(page.getByText("1–20 of 23")).toBeVisible();

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/page=2/);
    await selectOption(page, page.getByRole("combobox", { name: "Rows per page" }), "50 / page");
    await expect(page).toHaveURL(/pageSize=50/);
    await expect(page).not.toHaveURL(/page=2/); // page resets when the page size changes
    await expect(page.getByText("1–23 of 23")).toBeVisible();
    await expect(names).toHaveCount(23);
  });

  test("LEAD-14 tampered URL parameters fall back to safe, bounded values", async ({ page }) => {
    const seen = listRequests(page);
    await page.goto("/leads?pageSize=1000&page=-5&sort=evil;drop&dir=sideways&status=bogus&owner=me");
    await expect(page.getByRole("heading", { name: "Leads", level: 1 })).toBeVisible();
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    const b = body(seen.at(-1)!);
    expect(b).toMatchObject({ p_limit: 20, p_offset: 0, p_sort: "created_at", p_dir: "desc" });
    expect(b.p_statuses).toBeUndefined();
    expect(b.p_owner_id).toBeUndefined();
  });

  test("Admin sees owner column and can filter by owner", async ({ as }) => {
    const t = tag();
    const run = readRun();
    await createLead(userClient("salesB"), { name: `${t} of B` });
    await createLead(userClient("salesA"), { name: `${t} of A` });
    const page = await as("admin");
    await page.goto(`/leads?q=${encodeURIComponent(t)}`);
    await expect(page.getByRole("columnheader", { name: "Owner" })).toBeVisible();
    await expect(page.getByRole("link", { name: `${t} of A` })).toBeVisible();
    await page.goto(`/leads?q=${encodeURIComponent(t)}&owner=${run.ids.salesB}`);
    await expect(page.getByRole("link", { name: `${t} of B` })).toBeVisible();
    await expect(page.getByRole("link", { name: `${t} of A` })).toHaveCount(0);
  });
});
