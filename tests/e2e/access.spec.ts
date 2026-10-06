import type { Page } from "@playwright/test";
import type { AccountKey } from "./support/accounts";
import { expect, test } from "./support/fixtures";
import { stat } from "./support/ui";

// Settings lives in the account menu, not the sidebar.
const NAV = ["Dashboard", "Leads", "Follow-ups", "Library", "Finance", "Reports", "Users"] as const;

const sidebarLink = (page: Page, label: string) =>
  page.locator('[data-sidebar="sidebar"]').getByRole("link", { name: label, exact: true });

const matrix: Record<AccountKey, { nav: (typeof NAV)[number][]; blocked: string[]; cards: string[]; absentCards: string[] }> = {
  admin: {
    nav: ["Dashboard", "Leads", "Follow-ups", "Library", "Finance", "Reports", "Users"],
    blocked: [],
    cards: ["Active leads", "Follow-ups due today", "Overdue follow-ups", "Won leads"],
    absentCards: ["My active leads"],
  },
  salesA: {
    nav: ["Dashboard", "Leads", "Follow-ups", "Library", "Reports"],
    blocked: ["/finance", "/users", "/leads/niches"],
    cards: ["My active leads", "Today's tasks", "Overdue tasks", "My won leads"],
    absentCards: ["Total contributed capital", "Active leads"],
  },
  salesB: { nav: ["Dashboard", "Leads", "Follow-ups", "Library", "Reports"], blocked: ["/finance"], cards: ["My active leads"], absentCards: [] },
  account: {
    nav: ["Dashboard", "Finance", "Reports"],
    blocked: ["/leads", "/follow-ups", "/users", "/leads/niches"],
    cards: ["Total contributed capital", "Operating expenses this month"],
    absentCards: ["Active leads", "My active leads"],
  },
};

test.describe("Role-based navigation and page access", () => {
  for (const [key, spec] of Object.entries(matrix) as [AccountKey, (typeof matrix)[AccountKey]][]) {
    test(`ROLE-01..06 ${key}: sidebar, dashboard and blocked pages`, async ({ as }) => {
      const page = await as(key);
      await page.goto("/dashboard");

      for (const label of NAV) {
        if (spec.nav.includes(label)) await expect(sidebarLink(page, label), `${key} should see ${label}`).toBeVisible();
        else await expect(sidebarLink(page, label), `${key} must not see ${label}`).toHaveCount(0);
      }
      for (const card of spec.cards) await expect(stat(page, card), card).toHaveText(/\d|₹/);
      for (const card of spec.absentCards) await expect(stat(page, card)).toHaveCount(0);

      for (const path of spec.blocked) {
        await page.goto(path);
        await expect(page, `${key} → ${path}`).toHaveURL(/\/dashboard$/);
      }
    });
  }

  test("Sales landing puts tasks first with an Add lead action", async ({ as }) => {
    const page = await as("salesA");
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: /^Hi, E2E/ })).toBeVisible();
    await expect(page.getByText("Overdue", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Due today", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add lead" }).click();
    await expect(page.getByRole("dialog", { name: "Add lead" })).toBeVisible();
  });

  test("Unknown lead id and malformed id show a safe empty state", async ({ as }) => {
    const page = await as("salesA");
    await page.goto("/leads/00000000-0000-4000-8000-000000000000");
    await expect(page.getByText("Lead not available")).toBeVisible();
    // The shell streams before the page calls notFound(), so check the rendered 404 rather than the status.
    await page.goto("/leads/not-a-uuid");
    await expect(page.getByText(/could not be found/i)).toBeVisible();
  });
});
