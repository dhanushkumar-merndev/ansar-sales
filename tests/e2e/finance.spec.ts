import type { Page } from "@playwright/test";
import { storageState } from "./support/accounts";
import { tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { readFileSync } from "node:fs";
import { serviceClient, userClient } from "./support/supabase";
import { dialog, readINR, selectOption, stat, toast } from "./support/ui";
import { istToday, parsePeriod } from "../../src/lib/time";

test.use({ storageState: storageState("account") });

// Entries live on the month's report page; new entries default to today, so they land in this month.
const MONTH = istToday().slice(0, 7);
const MONTH_PAGE = `/finance/${MONTH}`;
const EXPENSES = "Expenses";
const CAPITAL = "Capital";
const CAPITAL_THIS_MONTH = "This Month Capital Gained"; // /finance summary card

async function addExpense(page: Page, amount: string, description: string, category?: string, extra: { item?: string; nos?: string; mode?: string; repeat?: boolean } = {}) {
  await page.getByRole("button", { name: "Add expense" }).click();
  const d = dialog(page, "Add expense");
  if (category) await selectOption(page, d.locator("#exp-cat"), category);
  await d.locator("#exp-amount").fill(amount);
  await selectOption(page, d.locator("#exp-mode"), extra.mode ?? "UPI");
  if (extra.item) await d.locator("#exp-item").fill(extra.item);
  if (extra.nos) await d.locator("#exp-qty").fill(extra.nos);
  if (extra.repeat) await d.getByRole("checkbox", { name: "Repeat every month" }).check();
  await d.locator("#exp-desc").fill(description);
  await d.getByRole("button", { name: "Save" }).click();
  await expect(toast(page, "Expense added")).toBeVisible();
  await expect(d).toBeHidden();
}

/** A row of the period page's entry list (charts and the "Largest expenses" table can show the same text). */
const row = (page: Page, text: string) => page.getByRole("region", { name: "Entries" }).getByRole("row").filter({ hasText: text });

async function rowAction(page: Page, text: string, action: string) {
  await row(page, text).getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

test.describe("Finance", () => {
  test("FIN-01/03 expenses add to this month's total exactly, to the paisa", async ({ page }) => {
    const t = tag();
    await page.goto(MONTH_PAGE);
    const expBefore = await readINR(page, EXPENSES);
    const capBefore = await readINR(page, CAPITAL);

    await addExpense(page, "1,234.56", `${t} internet`);
    await expect.poll(() => readINR(page, EXPENSES)).toBe(expBefore + 123456);
    await addExpense(page, "0.44", `${t} stamp`);
    await expect.poll(() => readINR(page, EXPENSES)).toBe(expBefore + 123500);
    expect(await readINR(page, CAPITAL)).toBe(capBefore);
    await expect(row(page, `${t} internet`)).toContainText("₹1,234.56");
  });

  test("FIN-02 capital is tracked separately and never counted as expense", async ({ page }) => {
    const t = tag();
    await page.goto(MONTH_PAGE);
    const expBefore = await readINR(page, EXPENSES);
    const capBefore = await readINR(page, CAPITAL);

    await page.getByRole("tab", { name: "Capital" }).click();
    await expect(page).toHaveURL(/tab=capital/);
    await page.getByRole("button", { name: "Add capital" }).click();
    const d = dialog(page, "Add capital");
    await d.locator("#cap-amount").fill("50000");
    await d.locator("#cap-from").fill(`${t} Partner`);
    await d.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Choose the mode of payment")).toBeVisible(); // first problem in a toast, fields highlighted
    await selectOption(page, d.locator("#cap-mode"), "Bank transfer");
    await d.locator("#cap-item").fill(`${t} Chair`);
    await d.locator("#cap-qty").fill("8");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Capital entry added")).toBeVisible();

    await expect.poll(() => readINR(page, CAPITAL)).toBe(capBefore + 5_000_000);
    expect(await readINR(page, EXPENSES)).toBe(expBefore);
    await expect(row(page, `${t} Partner`)).toContainText("₹50,000.00");
    await expect(row(page, `${t} Partner`)).toContainText(`${t} Chair × 8 nos`);
    await expect(row(page, `${t} Partner`)).toContainText("Bank transfer");
  });

  test("FIN-11 expense item, nos and mode of payment are saved; nos needs an item", async ({ page }) => {
    const t = tag();
    await page.goto(MONTH_PAGE);
    await page.getByRole("button", { name: "Add expense" }).click();
    const d = dialog(page, "Add expense");
    await d.locator("#exp-amount").fill("1999");
    await selectOption(page, d.locator("#exp-mode"), "Card");
    await d.locator("#exp-qty").fill("2");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Name the item for this quantity")).toBeVisible();
    await d.locator("#exp-item").fill(`${t} ChatGPT`);
    await d.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Expense added")).toBeVisible();
    await expect(row(page, `${t} ChatGPT`)).toContainText(`${t} ChatGPT × 2 nos`);
    await expect(row(page, `${t} ChatGPT`)).toContainText("Card");
  });

  test("FIN-12 a monthly expense is marked Monthly and the next month is added automatically", async ({ page }) => {
    const t = tag();
    await page.goto(MONTH_PAGE);
    await addExpense(page, "499", `${t} canva plan`, "Software", { item: `${t} Canva`, repeat: true });
    await expect(row(page, `${t} canva plan`).getByText("Monthly")).toBeVisible();

    const db = serviceClient();
    const { data: e } = await db.from("expenses").select("id, expense_date, recurrence_id").eq("description", `${t} canva plan`).single();
    expect(e!.recurrence_id).toBeTruthy();
    const { data: r } = await db.from("expense_recurrences").select("next_date, active").eq("id", e!.recurrence_id!).single();
    expect(r!.active).toBe(true);
    expect(r!.next_date > e!.expense_date && r!.next_date.slice(0, 7) !== e!.expense_date.slice(0, 7)).toBe(true); // next month

    // Untick: the series stops, past entries stay.
    await rowAction(page, `${t} canva plan`, "Edit");
    const d = dialog(page, "Edit expense");
    await expect(d.getByRole("checkbox", { name: "Repeat every month" })).toBeChecked();
    await d.getByRole("checkbox", { name: "Repeat every month" }).uncheck();
    await d.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Expense updated")).toBeVisible();
    await expect(row(page, `${t} canva plan`).getByText("Monthly")).toHaveCount(0);
    const { data: stopped } = await db.from("expense_recurrences").select("active").eq("id", e!.recurrence_id!).single();
    expect(stopped!.active).toBe(false);
  });

  test("FIN-04 invalid amounts are rejected and nothing is saved", async ({ page }) => {
    const t = tag();
    await page.goto(MONTH_PAGE);
    await page.getByRole("button", { name: "Add expense" }).click();
    const d = dialog(page, "Add expense");
    await d.locator("#exp-desc").fill(`${t} invalid`);
    for (const [amount, message] of [
      ["0", "Amount must be positive"],
      ["12.345", "Enter an amount with up to 2 decimals"],
      ["-5", "Enter an amount with up to 2 decimals"],
      ["abc", "Enter an amount with up to 2 decimals"],
      ["", "Enter an amount with up to 2 decimals"],
    ]) {
      await d.locator("#exp-amount").fill(amount);
      await d.getByRole("button", { name: "Save" }).click();
      await expect(toast(page, message), `amount "${amount}"`).toBeVisible();
      await expect(d.locator("#exp-amount")).toHaveAttribute("aria-invalid", "true");
    }
    await expect(d).toBeVisible();
    const { count } = await serviceClient().from("expenses").select("id", { count: "exact", head: true }).eq("description", `${t} invalid`);
    expect(count).toBe(0);
  });

  test("FIN-05/06 edits are audited; archive removes from totals and restore adds back", async ({ page }) => {
    const t = tag();
    await page.goto(MONTH_PAGE);
    const base = await readINR(page, EXPENSES);
    await addExpense(page, "1234.56", `${t} rent share`, "Rent");
    await expect.poll(() => readINR(page, EXPENSES)).toBe(base + 123456);

    await rowAction(page, `${t} rent share`, "Edit");
    const d = dialog(page, "Edit expense");
    await expect(d.locator("#exp-amount")).toHaveValue("1234.56");
    await d.locator("#exp-amount").fill("1300");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Expense updated")).toBeVisible();
    await expect.poll(() => readINR(page, EXPENSES)).toBe(base + 130000);

    await rowAction(page, `${t} rent share`, "History");
    const h = dialog(page, "History");
    await expect(h).toContainText("E2E Account updated");
    await expect(h).toContainText("Amount: ₹1,234.56 → ₹1,300.00");
    await expect(h).toContainText("E2E Account created");
    await page.keyboard.press("Escape");

    await rowAction(page, `${t} rent share`, "Archive");
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive" }).click();
    await expect(toast(page, "Archived")).toBeVisible();
    await expect.poll(() => readINR(page, EXPENSES)).toBe(base);
    await expect(row(page, `${t} rent share`)).toHaveCount(0);

    await page.getByLabel("Archived").check();
    await rowAction(page, `${t} rent share`, "Restore");
    await page.getByRole("alertdialog").getByRole("button", { name: "Restore" }).click();
    await expect(toast(page, "Restored")).toBeVisible();
    await expect.poll(() => readINR(page, EXPENSES)).toBe(base + 130000);
  });

  test("FIN-07 category filter is applied server-side and kept in the URL", async ({ page }) => {
    const t = tag();
    await page.goto(MONTH_PAGE);
    await addExpense(page, "999", `${t} figma`, "Software");
    await addExpense(page, "111", `${t} tea`, "Miscellaneous");
    await selectOption(page, page.getByRole("combobox", { name: "Category" }), "Software");
    await expect(page).toHaveURL(/category=software/);
    await expect(row(page, `${t} figma`)).toBeVisible();
    await expect(row(page, `${t} tea`)).toHaveCount(0);
  });

  test("FIN-08/09 admin has finance access; no profit, ROI or cash figures are shown", async ({ as }) => {
    const admin = await as("admin");
    await admin.goto("/finance");
    await expect(admin.getByRole("button", { name: "Add expense" })).toBeVisible();
    await expect(stat(admin, CAPITAL_THIS_MONTH)).toHaveText(/₹/);
    // AGENTS.md: no profit, available cash or ROI without income data (capital is not revenue).
    const labels = await admin.locator('[data-slot="card-description"]').allInnerTexts();
    expect(labels.filter((l) => /profit|roi|cash|surplus|balance/i.test(l)), "forbidden finance figures").toEqual([]);
  });

  test("FIN-10 month cards show the month's totals and open its report; the year chart is there too", async ({ page }) => {
    const t = tag();
    await page.goto(MONTH_PAGE);
    await addExpense(page, "777.70", `${t} card check`);
    const expense = await readINR(page, EXPENSES);

    await page.goto("/finance");
    const card = page.getByRole("link", { name: `${parsePeriod(MONTH)!.label} report` });
    await expect(card).toContainText(formatPaise(expense));
    await expect(page.getByText(`${MONTH.slice(0, 4)} by month`)).toBeVisible();
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/finance/${MONTH}$`));
    await expect(page.getByRole("heading", { name: parsePeriod(MONTH)!.label })).toBeVisible();
    await expect(page.getByText("Day by day")).toBeVisible();
  });

  test("FIN-13 period report: search, filters, sort and paging in the URL; previous/next; CSV download", async ({ page, run }) => {
    const t = tag();
    const today = istToday();
    const { error } = await userClient("account").from("expenses").insert([
      { expense_date: today, category: "software", amount: 300, payment_mode: "card", item: `${t} Zoom`, created_by: run.ids.account },
      { expense_date: today, category: "software", amount: 100, payment_mode: "upi", item: `${t} Notion`, created_by: run.ids.account },
      { expense_date: today, category: "marketing", amount: 200, payment_mode: "card", item: `${t} Flyers`, description: `=SUM(1) "quoted", text`, created_by: run.ids.account },
    ] as never);
    expect(error).toBeNull();

    await page.goto(MONTH_PAGE);
    await page.getByRole("textbox", { name: "Search entries" }).fill(t);
    await expect(page).toHaveURL(/[?&]q=/);
    await expect(row(page, t)).toHaveCount(3);

    await selectOption(page, page.getByRole("combobox", { name: "Sort" }), "Lowest amount");
    await expect(page).toHaveURL(/sort=amount-asc/);
    await expect(row(page, t).first()).toContainText(`${t} Notion`);

    await selectOption(page, page.getByRole("combobox", { name: "Mode of payment" }), "Card");
    await expect(page).toHaveURL(/mode=card/);
    await expect(row(page, t)).toHaveCount(2);

    // State survives a reload (it lives in the URL).
    await page.reload();
    await expect(row(page, t)).toHaveCount(2);
    await expect(page.getByRole("textbox", { name: "Search entries" })).toHaveValue(t);

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
    expect(download.suggestedFilename()).toBe(`expenses-${MONTH}.csv`);
    const csv = readFileSync((await download.path())!, "utf8");
    expect(csv).toContain("Date,Category,Item,Nos,Amount (INR),Mode of payment,Monthly,Description,Recorded by");
    expect(csv).toContain(`${t} Zoom`);
    expect(csv).toContain(`"'=SUM(1) ""quoted"", text"`); // formula-safe and quoted
    expect(csv).not.toContain(`${t} Notion`); // UPI is filtered out

    await page.getByRole("link", { name: /^Previous:/ }).click();
    await expect(page).toHaveURL(new RegExp(`/finance/${parsePeriod(MONTH)!.prev}$`));
    await expect(page.getByRole("button", { name: "Next period (not started)" })).toHaveCount(0);
    await page.getByRole("link", { name: /^Next:/ }).click();
    await expect(page).toHaveURL(new RegExp(`/finance/${MONTH}$`));
    await expect(page.getByRole("button", { name: "Next period (not started)" })).toBeDisabled();
  });

  test("FIN-14 an invalid period is not found", async ({ page }) => {
    await page.goto("/finance/2026-13");
    await expect(page.getByText(/could not be found/i)).toBeVisible();
  });

  test("FIN-15 sales cannot open a finance report", async ({ as }) => {
    const sales = await as("salesA");
    await sales.goto(MONTH_PAGE);
    await expect(sales).toHaveURL(/\/dashboard$/);
  });
});

/** 12345678 paise → "₹1,23,456.78" (en-IN grouping). */
function formatPaise(p: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 }).format(p / 100);
}
