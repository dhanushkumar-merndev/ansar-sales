import { createLead, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { serviceClient, userClient } from "./support/supabase";
import { dialog } from "./support/ui";

test.describe("Niche combobox", () => {
  test("NICHE-02 an exact match ignoring case and spacing is offered instead of Create", async ({ as }) => {
    const t = tag();
    await createLead(userClient("salesA"), { name: `${t} Seed`, niche: { newName: `${t} Fitness` } });
    const page = await as("salesA");
    await page.goto("/leads");
    await page.getByRole("button", { name: "Add lead" }).first().click();
    await dialog(page, "Add lead").locator("#lead-niche").click();
    await page.getByPlaceholder("Search niches…").fill(`  ${t.toUpperCase()}    fitness `);
    await expect(page.getByRole("option", { name: `${t} Fitness`, exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: /^Create/ })).toHaveCount(0);

    await page.getByPlaceholder("Search niches…").fill(`${t} Fitness Studio`);
    await expect(page.getByRole("option", { name: `Create “${t} Fitness Studio”` })).toBeVisible();
  });

  test("NICHE-03 a niche saved by Sales A is available to Sales B without reload", async ({ as }) => {
    const t = tag();
    const b = await as("salesB");
    await b.goto("/leads");
    await b.getByRole("button", { name: "Add lead" }).first().click();

    await createLead(userClient("salesA"), { name: `${t} Seed`, niche: { newName: `${t} Dental` } });

    await dialog(b, "Add lead").locator("#lead-niche").click();
    await b.getByPlaceholder("Search niches…").fill(`${t} dent`);
    await expect(b.getByRole("option", { name: `${t} Dental`, exact: true })).toBeVisible();
  });

  test("NICHE-04 concurrent creation of the same normalised niche yields one row", async () => {
    const t = tag();
    const [x, y] = await Promise.all([
      createLead(userClient("salesA"), { name: `${t} One`, niche: { newName: `${t} Salon` } }),
      createLead(userClient("salesB"), { name: `${t} Two`, niche: { newName: `  ${t.toLowerCase()}   SALON ` } }),
    ]);
    const sb = serviceClient();
    const { data: niches } = await sb.from("niches").select("id, name").eq("normalized_name", `${t} salon`.toLowerCase());
    expect(niches).toHaveLength(1);
    const { data: leads } = await sb.from("leads").select("niche_id").in("id", [x.id, y.id]);
    expect(new Set(leads!.map((l) => l.niche_id))).toEqual(new Set([niches![0].id]));
  });
});
