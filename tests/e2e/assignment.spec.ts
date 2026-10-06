import { createLead, minutesFromNow, phone, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { serviceClient, userClient } from "./support/supabase";
import { createNiche, dialog, selectOption, timelineItems, toast } from "./support/ui";

test.describe("Admin assignment, reassignment and archive", () => {
  test("LEAD-09 admin creates a lead for Sales A; only Sales A can open it", async ({ as, run }) => {
    const t = tag();
    const admin = await as("admin");
    await admin.goto("/leads");
    await admin.getByRole("button", { name: "Add lead" }).first().click();
    const d = dialog(admin, "Add lead");
    await d.locator("#lead-name").fill(`${t} Assigned`);
    await d.locator("#lead-phone").fill(phone().e164);
    await createNiche(admin, d.locator("#lead-niche"), `${t} Niche`);
    await selectOption(admin, d.locator("#lead-owner"), "E2E Sales A");
    await d.getByRole("button", { name: "Create lead" }).click();
    await expect(toast(admin, "Lead created")).toBeVisible();

    const { data: lead } = await serviceClient().from("leads").select("id, owner_id, created_by").eq("name", `${t} Assigned`).single();
    expect(lead).toMatchObject({ owner_id: run.ids.salesA, created_by: run.ids.admin });

    const a = await as("salesA");
    await a.goto(`/leads/${lead!.id}`);
    await expect(a.getByRole("heading", { name: `${t} Assigned` })).toBeVisible();
    const b = await as("salesB");
    await b.goto(`/leads/${lead!.id}`);
    await expect(b.getByText("Lead not available")).toBeVisible();
  });

  test("FU-08 TL-06 reassignment moves access, pending follow-ups and the reminder recipient", async ({ as, run }) => {
    const t = tag();
    const { id } = await createLead(userClient("admin"), {
      name: `${t} Moving`, ownerId: run.ids.salesA, followUpAt: minutesFromNow(2 * 24 * 60), followUpTask: `${t} task`, // "Upcoming" = after today (IST)
    });

    const admin = await as("admin");
    await admin.goto(`/leads/${id}`);
    await admin.getByRole("button", { name: "More actions" }).click();
    await admin.getByRole("menuitem", { name: "Reassign" }).click();
    const d = dialog(admin, "Reassign lead");
    await selectOption(admin, d.getByRole("combobox"), "E2E Sales B");
    await d.getByRole("button", { name: "Reassign" }).click();
    await expect(toast(admin, "Lead reassigned")).toBeVisible();
    await expect(timelineItems(admin).first()).toContainText("reassigned the lead from E2E Sales A to E2E Sales B");

    const a = await as("salesA");
    await a.goto(`/leads/${id}`);
    await expect(a.getByText("Lead not available")).toBeVisible();
    await a.goto(`/follow-ups?view=upcoming&q=${encodeURIComponent(t)}`);
    await expect(a.getByText("No follow-ups here")).toBeVisible();

    const b = await as("salesB");
    await b.goto(`/follow-ups?view=upcoming&q=${encodeURIComponent(t)}`);
    await expect(b.getByText(`${t} task`)).toBeVisible();

    const sb = serviceClient();
    const { data: fu } = await sb.from("follow_ups").select("id, assignee_id").eq("lead_id", id).single();
    expect(fu!.assignee_id).toBe(run.ids.salesB);
    const { data: rd } = await sb.from("reminder_deliveries").select("recipient_id, state").eq("follow_up_id", fu!.id).eq("state", "pending");
    expect(rd).toEqual([{ recipient_id: run.ids.salesB, state: "pending" }]);
  });

  test("LEAD-19 archive hides the lead from its owner and stops reminders; restore brings it back", async ({ as }) => {
    const t = tag();
    const { id } = await createLead(userClient("salesB"), { name: `${t} Archive me`, followUpAt: minutesFromNow(300) });

    const admin = await as("admin");
    await admin.goto(`/leads/${id}`);
    await admin.getByRole("button", { name: "More actions" }).click();
    await admin.getByRole("menuitem", { name: "Archive" }).click();
    await admin.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
    await expect(toast(admin, "Lead archived")).toBeVisible();
    await expect(admin.getByText(/^Archived .* Restore it to make changes\.$/)).toBeVisible();
    await expect(admin.getByRole("button", { name: "Edit" })).toHaveCount(0);

    const b = await as("salesB");
    await b.goto(`/leads?q=${encodeURIComponent(t)}`);
    await expect(b.getByText("No leads match")).toBeVisible();

    await admin.goto(`/leads?q=${encodeURIComponent(t)}`);
    await expect(admin.getByText("No leads match")).toBeVisible();
    await admin.goto(`/leads?q=${encodeURIComponent(t)}&archived=1`);
    await expect(admin.getByRole("link", { name: `${t} Archive me` })).toBeVisible();

    await admin.goto(`/leads/${id}`);
    await admin.getByRole("button", { name: "More actions" }).click();
    await admin.getByRole("menuitem", { name: "Restore" }).click();
    await admin.getByRole("alertdialog").getByRole("button", { name: "Restore" }).click();
    await expect(toast(admin, "Lead restored")).toBeVisible();
    await b.goto(`/leads?q=${encodeURIComponent(t)}`);
    await expect(b.getByRole("link", { name: `${t} Archive me` })).toBeVisible();

    const types = (await serviceClient().from("lead_activities").select("type").eq("lead_id", id)).data!.map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(["lead_archived", "lead_restored"]));
  });

  test("NICHE-05 admin renames and archives a niche; archived niche cannot be picked for new leads", async ({ as }) => {
    const t = tag();
    await createLead(userClient("salesA"), { name: `${t} Uses niche`, niche: { newName: `${t} Bakery` } });
    const admin = await as("admin");
    await admin.goto(`/leads/niches?q=${encodeURIComponent(t)}`);
    await admin.getByLabel("Search niches").fill(t);
    const row = admin.locator('[data-slot="card"] > div').filter({ hasText: `${t} Bakery` });
    await expect(row).toContainText("1 leads");
    await row.getByRole("button", { name: "Rename" }).click();
    await dialog(admin, "Rename niche").getByLabel("Niche name").fill(`${t} Bakeries`);
    await dialog(admin, "Rename niche").getByRole("button", { name: "Save" }).click();
    await expect(toast(admin, "Niche renamed")).toBeVisible();

    const renamed = admin.locator('[data-slot="card"] > div').filter({ hasText: `${t} Bakeries` });
    await renamed.getByRole("button", { name: "Archive" }).click();
    await admin.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
    await expect(toast(admin, "Niche archived")).toBeVisible();

    // The existing lead keeps its (renamed) niche; Sales cannot choose it any more.
    const sales = await as("salesA");
    await sales.goto(`/leads?q=${encodeURIComponent(t)}`);
    await expect(sales.getByRole("cell", { name: `${t} Bakeries` })).toBeVisible();
    await sales.getByRole("button", { name: "Add lead" }).first().click();
    const d = dialog(sales, "Add lead");
    await d.locator("#lead-niche").click();
    await sales.getByPlaceholder("Search niches…").fill(`${t} Bakeries`);
    await expect(sales.getByText(/is archived\. Choose another niche\./)).toBeVisible();
    await expect(sales.getByRole("option", { name: /^Create/ })).toHaveCount(0);
  });
});
