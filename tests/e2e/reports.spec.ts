import { createLead, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { userClient } from "./support/supabase";
import { stat } from "./support/ui";
import { istToday } from "../../src/lib/time";

const chartCard = (title: string) => `[data-slot="card"]:has([data-slot="card-title"]:text-is("${title}"))`;

test.describe("Reports", () => {
  test("REP-01 admin sees team sales and finance reports for the chosen range, kept in the URL", async ({ as }) => {
    await createLead(userClient("salesA"), { name: `${tag()} Report lead` });
    const page = await as("admin");
    await page.goto("/reports");
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
    await expect(stat(page, "Leads created")).not.toHaveText("0");
    await expect(page.locator(chartCard("By salesperson"))).toBeVisible();
    await expect(page.locator(chartCard("Stage funnel")).locator('[role="img"]')).toBeVisible();

    await page.getByRole("button", { name: "Report date range" }).click();
    await page.getByRole("button", { name: "This year", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`from=${istToday().slice(0, 4)}-01-01`));
    await page.getByRole("tab", { name: "Finance" }).click();
    await expect(page).toHaveURL(/tab=finance/);
    await expect(stat(page, "Capital contributed")).toHaveText(/₹/);
  });

  test("REP-02 items with nos and mode of payment show up in the finance report", async ({ as, run }) => {
    const t = tag();
    const today = istToday();
    const { error } = await userClient("account").from("expenses").insert({
      expense_date: today, category: "software", amount: 1500, item: `${t} Canva`, quantity: 3, payment_mode: "card", created_by: run.ids.account,
    } as never);
    expect(error).toBeNull();
    const page = await as("account");
    await page.goto(`/reports?from=${today}&to=${today}`);
    await expect(page.getByRole("tab", { name: "Sales" })).toHaveCount(0); // finance only
    const row = page.locator(chartCard("Items")).getByRole("row").filter({ hasText: `${t} Canva` });
    await expect(row).toContainText("Expense");
    await expect(row).toContainText("₹1,500.00");
    await expect(row).toContainText("₹500.00"); // per unit
    await expect(page.locator(chartCard("Mode of payment"))).toBeVisible();
  });

  test("REP-03 sales sees only their own report, with no finance tab or salesperson comparison", async ({ as }) => {
    const page = await as("salesA");
    await page.goto("/reports?tab=finance");
    await expect(page.getByRole("tab", { name: "Finance" })).toHaveCount(0);
    await expect(stat(page, "Leads created")).toHaveText(/\d/);
    await expect(page.locator(chartCard("By salesperson"))).toHaveCount(0);
    await expect(stat(page, "Capital contributed")).toHaveCount(0);
  });
});
