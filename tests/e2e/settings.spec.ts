import { randomBytes } from "node:crypto";
import { expect, test } from "./support/fixtures";
import { createAuthUser } from "./support/supabase";
import { signIn, toast } from "./support/ui";

test.describe("Settings: change own password", () => {
  test("AUTH-13/14/15 wrong current password, mismatch and short password are rejected; success works on next sign-in", async ({ page, browser, baseURL }) => {
    // Dedicated user so the shared accounts keep their password.
    const username = `e2e_tmp_${randomBytes(3).toString("hex")}`;
    const oldPw = `Pw-${randomBytes(9).toString("hex")}`;
    const newPw = `Pw-${randomBytes(9).toString("hex")}`;
    await createAuthUser({ username, displayName: "E2E Password", role: "account", password: oldPw });

    await signIn(page, username, oldPw);
    await page.waitForURL("**/dashboard");
    await page.goto("/settings");
    await expect(page.getByText(`@${username}`).first()).toBeVisible();

    const current = page.locator("#pw-current");
    const next = page.locator("#pw-new");
    const confirm = page.locator("#pw-confirm");
    const submit = page.getByRole("button", { name: "Update password" });
    const error = page.locator('[data-slot="field-error"]');

    await current.fill(oldPw);
    await next.fill("short");
    await expect(submit).toBeDisabled();

    await next.fill(newPw);
    await confirm.fill(`${newPw}x`);
    await submit.click();
    await expect(error).toHaveText("New passwords don't match.");

    await current.fill(`${oldPw}-wrong`);
    await confirm.fill(newPw);
    await submit.click();
    await expect(error).toHaveText("Current password is incorrect.");

    await current.fill(oldPw);
    await submit.click();
    await expect(toast(page, "Password changed")).toBeVisible();
    await expect(current).toHaveValue("");

    const ctx = await browser.newContext({ baseURL });
    const fresh = await ctx.newPage();
    await signIn(fresh, username, newPw);
    await fresh.waitForURL("**/dashboard");
    await ctx.close();
  });
});
