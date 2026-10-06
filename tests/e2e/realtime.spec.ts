import { createLead, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { userClient } from "./support/supabase";
import { dialog, readCount, refocus, waitForLive } from "./support/ui";

const LIVE = { timeout: 20_000 };

test.describe("Realtime and freshness (no manual reload)", () => {
  test("RT-01/03 a new lead appears on the open Admin list but never on another salesperson's list", async ({ as }) => {
    const t = tag();
    const admin = await as("admin");
    const salesB = await as("salesB");
    for (const p of [admin, salesB]) {
      await p.goto(`/leads?q=${encodeURIComponent(t)}`);
      await expect(p.getByText("No leads match")).toBeVisible();
      await waitForLive(p);
    }

    await createLead(userClient("salesA"), { name: `${t} Live lead` });

    await expect(admin.getByRole("link", { name: `${t} Live lead` })).toBeVisible(LIVE);
    await salesB.waitForTimeout(3_000);
    await refocus(salesB);
    await expect(salesB.getByRole("link", { name: `${t} Live lead` })).toHaveCount(0);
    await expect(salesB.getByText("No leads match")).toBeVisible();
  });

  test("RT-02 the open Admin dashboard totals update", async ({ as }) => {
    const t = tag();
    const admin = await as("admin");
    await admin.goto("/dashboard");
    await waitForLive(admin);
    const before = await readCount(admin, "Active leads");

    await createLead(userClient("salesA"), { name: `${t} Counted` });
    await expect.poll(() => readCount(admin, "Active leads"), LIVE).toBe(before + 1);
  });

  test("RT-04 a lead reassigned away disappears from the former owner's open list", async ({ as, api, run }) => {
    const t = tag();
    const { id } = await createLead(userClient("salesA"), { name: `${t} Leaving` });
    const salesA = await as("salesA");
    await salesA.goto(`/leads?q=${encodeURIComponent(t)}`);
    await expect(salesA.getByRole("link", { name: `${t} Leaving` })).toBeVisible();

    const { error } = await api("admin").from("leads").update({ owner_id: run.ids.salesB } as never).eq("id", id);
    expect(error).toBeNull();

    // RLS hides the update from the former owner, so the focus/poll fallback must remove it.
    await refocus(salesA);
    await expect(salesA.getByRole("link", { name: `${t} Leaving` })).toHaveCount(0, LIVE);
  });

  test("RT-05 a background refresh never wipes an unsaved form", async ({ as }) => {
    const t = tag();
    const salesA = await as("salesA");
    await salesA.goto(`/leads?q=${encodeURIComponent(t)}`);
    await waitForLive(salesA);
    await salesA.getByRole("button", { name: "Add lead" }).first().click();
    const d = dialog(salesA, "Add lead");
    await d.locator("#lead-name").fill(`${t} half typed`);
    await d.locator("#lead-email").fill("draft@example.com");

    await createLead(userClient("salesA"), { name: `${t} Background` });
    await salesA.waitForTimeout(2_000);
    await refocus(salesA);

    await expect(d.locator("#lead-name")).toHaveValue(`${t} half typed`);
    await expect(d.locator("#lead-email")).toHaveValue("draft@example.com");
  });
});
