import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { ACCOUNTS, storageState } from "./support/accounts";
import { createLead } from "./support/data";
import { expect, test } from "./support/fixtures";
import { createAuthUser, serviceClient, userClient } from "./support/supabase";
import { dialog, formAlert, selectOption, signIn, toast } from "./support/ui";

test.use({ storageState: storageState("admin") });

const INVALID = "Invalid username or password.";
const rnd = () => randomBytes(3).toString("hex");
const pw = () => `Pw-${randomBytes(9).toString("hex")}`;

async function tempUser(role: "sales" | "account" = "sales") {
  const u = { username: `e2e_tmp_${rnd()}`, displayName: `E2E Temp ${rnd()}`, role, password: pw() } as const;
  const id = await createAuthUser(u);
  return { ...u, id };
}

async function openUserActions(page: Page, displayName: string, action: string) {
  await page.goto("/users");
  await page.getByRole("searchbox", { name: "Search users" }).filter({ visible: true }).fill(displayName);
  await page.getByRole("button", { name: `Actions for ${displayName}` }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

/** Clicks `trigger` and returns the server action id the browser invoked (the Next-Action header). */
async function captureActionId(page: Page, trigger: () => Promise<void>) {
  const req = page.waitForRequest((r) => r.method() === "POST" && Boolean(r.headers()["next-action"]));
  await trigger();
  return (await req).headers()["next-action"];
}

test.describe("User management (admin)", () => {
  test("USER-01 ROLE-13 admin creates a user who can sign in at once; Sales cannot call the same server actions", async ({ page, as, browser, baseURL, run }) => {
    const u = { username: `e2e_tmp_${rnd()}`, displayName: `E2E New ${rnd()}`, password: pw() };
    await page.goto("/users");
    await page.getByRole("button", { name: "New user" }).click();
    const d = dialog(page, "New user");
    await d.locator("#u-username").fill(`  ${u.username.toUpperCase()} `); // normalised to lower case
    await d.locator("#u-name").fill(u.displayName);
    await selectOption(page, d.locator("#u-role"), "Sales");
    await d.locator("#u-password").fill(u.password);
    const createUserAction = await captureActionId(page, () => d.getByRole("button", { name: "Create user" }).click());
    await expect(toast(page, `User @${u.username} created`)).toBeVisible();

    const fresh = await browser.newContext({ baseURL });
    const newPage = await fresh.newPage();
    await signIn(newPage, u.username, u.password);
    await newPage.waitForURL("**/dashboard");
    await expect(newPage.getByRole("heading", { name: /^Hi, E2E/ })).toBeVisible();
    await fresh.close();

    // Capture updateUser's action id through a harmless rename.
    await openUserActions(page, u.displayName, "Edit name / role");
    const edit = dialog(page, `Edit @${u.username}`);
    await edit.locator("#e-name").fill(`${u.displayName} R`);
    const updateUserAction = await captureActionId(page, () => edit.getByRole("button", { name: "Save" }).click());
    await expect(toast(page, "User updated")).toBeVisible();

    // A signed-in Sales user replays both actions with their own session.
    const sales = await as("salesA");
    await sales.goto("/dashboard");
    const call = (id: string, args: unknown[]) =>
      sales.request.post("/dashboard", {
        headers: { "next-action": id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
        data: JSON.stringify(args),
      });
    const hacker = `e2e_hack_${rnd()}`;
    const created = await call(createUserAction, [{ username: hacker, displayName: "Hacker", role: "admin", password: pw() }]);
    expect(await created.text()).toContain("forbidden");
    const escalated = await call(updateUserAction, [{ id: run.ids.salesA, role: "admin" }]);
    expect(await escalated.text()).toContain("forbidden");

    const sb = serviceClient();
    expect((await sb.from("profiles").select("id").eq("username", hacker)).data).toHaveLength(0);
    expect((await sb.from("profiles").select("role").eq("id", run.ids.salesA).single()).data?.role).toBe("sales");
  });

  test("USER-02/03 duplicate username, invalid username and short password are rejected", async ({ page }) => {
    await page.goto("/users");
    await page.getByRole("button", { name: "New user" }).click();
    const d = dialog(page, "New user");
    const errors = d.locator('[data-slot="field-error"]');

    await d.locator("#u-username").fill(ACCOUNTS.salesA.username);
    await d.locator("#u-name").fill("Duplicate");
    await d.locator("#u-password").fill(pw());
    await d.getByRole("button", { name: "Create user" }).click();
    await expect(errors.filter({ hasText: "Already taken" })).toBeVisible();

    await d.locator("#u-username").fill("A b!");
    await d.getByRole("button", { name: "Create user" }).click();
    await expect(errors.filter({ hasText: "3–32 characters" })).toBeVisible();

    await d.locator("#u-username").fill(`e2e_tmp_${rnd()}`);
    await d.locator("#u-password").fill("short");
    await d.getByRole("button", { name: "Create user" }).click();
    await expect(errors.filter({ hasText: "At least 8 characters" })).toBeVisible();
    await expect(d).toBeVisible();
  });

  test("USER-04 role cannot change while the user still owns active leads", async ({ page }) => {
    const u = await tempUser("sales");
    await createLead(userClient("admin"), { name: `${u.displayName} lead`, ownerId: u.id });
    await openUserActions(page, u.displayName, "Edit name / role");
    const d = dialog(page, `Edit @${u.username}`);
    await selectOption(page, d.locator("#e-role"), "Account");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d.getByText("Reassign this user's active leads before changing their role.")).toBeVisible();
    expect((await serviceClient().from("profiles").select("role").eq("id", u.id).single()).data?.role).toBe("sales");
  });

  test("AUTH-12 admin password reset: old password stops working, new one works", async ({ page, browser, baseURL }) => {
    const u = await tempUser();
    const next = pw();
    await openUserActions(page, u.displayName, "Reset password");
    const d = dialog(page, "Reset password");
    await d.locator("#r-pass").fill(next);
    await d.getByRole("button", { name: "Reset" }).click();
    await expect(toast(page, "Password reset")).toBeVisible();

    const ctx = await browser.newContext({ baseURL });
    const p = await ctx.newPage();
    await signIn(p, u.username, u.password);
    await expect(formAlert(p)).toHaveText(INVALID);
    await signIn(p, u.username, next);
    await p.waitForURL("**/dashboard");
    await ctx.close();
  });

  test("AUTH-10/11 USER-06 deactivation cuts off an open session and sign-in; reactivation restores it", async ({ page, browser, baseURL }) => {
    const u = await tempUser();
    const ctx = await browser.newContext({ baseURL });
    const userPage = await ctx.newPage();
    await signIn(userPage, u.username, u.password);
    await userPage.waitForURL("**/dashboard");

    await openUserActions(page, u.displayName, "Deactivate");
    await page.getByRole("alertdialog").getByRole("button", { name: "Deactivate" }).click();
    await expect(toast(page, "User deactivated")).toBeVisible();
    // The row menu stays open after the confirm dialog closes and hides the table from the a11y tree.
    await expect(page.getByRole("alertdialog")).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(page.locator("tr").filter({ hasText: u.displayName })).toContainText("Deactivated");

    // The still-valid session is refused on its very next request.
    await userPage.goto("/leads");
    await userPage.waitForURL(/\/login\?error=inactive/);
    await expect(formAlert(userPage)).toHaveText("Your account is deactivated. Contact an admin.");
    await signIn(userPage, u.username, u.password);
    await expect(formAlert(userPage)).toHaveText(INVALID);

    await openUserActions(page, u.displayName, "Reactivate");
    await page.getByRole("alertdialog").getByRole("button", { name: "Reactivate" }).click();
    await expect(toast(page, "User reactivated")).toBeVisible();
    await signIn(userPage, u.username, u.password);
    await userPage.waitForURL("**/dashboard");
    await ctx.close();
  });

  test("USER-05 search and role filter are server-side", async ({ page }) => {
    const u = await tempUser("account");
    await page.goto("/users");
    await page.getByRole("searchbox", { name: "Search users" }).filter({ visible: true }).fill(u.username);
    await expect(page.getByRole("row").filter({ hasText: u.displayName })).toBeVisible();
    await selectOption(page, page.getByRole("combobox", { name: "Role" }), "Sales");
    await expect(page).toHaveURL(/role=sales/);
    await expect(page.getByText("No users found")).toBeVisible();
  });
});
