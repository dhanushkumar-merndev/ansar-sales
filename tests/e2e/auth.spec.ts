import { randomBytes } from "node:crypto";
import { ACCOUNTS } from "./support/accounts";
import { expect, test } from "./support/fixtures";
import { anonClient, authEmail, createAuthUser, serviceClient } from "./support/supabase";
import { formAlert, signIn } from "./support/ui";

const INVALID = "Invalid username or password.";

test.describe("Authentication", () => {
  test("AUTH-05 signed-out visitors are sent to login with the original path", async ({ request }) => {
    for (const [path, next] of [["/dashboard", "/dashboard"], ["/leads?status=won", "/leads?status=won"], ["/finance", "/finance"]]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(307);
      const location = new URL(res.headers().location, "http://x");
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("next")).toBe(next);
    }
  });

  test("AUTH-02/03/04 wrong password, unknown and malformed usernames get the same generic error", async ({ page, run }) => {
    for (const [username, password] of [
      [ACCOUNTS.salesA.username, `${run.password}-wrong`],
      [`e2e_nobody_${randomBytes(3).toString("hex")}`, run.password],
      ["a", run.password],
      ["sales a; drop", run.password],
    ]) {
      await signIn(page, username, password);
      await expect(formAlert(page)).toHaveText(INVALID);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("AUTH-01/06 username + password sign-in honours the next parameter", async ({ page, run }) => {
    await signIn(page, ACCOUNTS.salesB.username, run.password, `/login?next=${encodeURIComponent("/leads?status=won")}`);
    await page.waitForURL("**/leads?status=won");
    await expect(page.getByRole("heading", { name: "Leads", level: 1 })).toBeVisible();
  });

  test("AUTH-07 next parameter cannot redirect off-site", async ({ page, run }) => {
    await signIn(page, ACCOUNTS.salesB.username, run.password, `/login?next=${encodeURIComponent("//evil.example/phish")}`);
    await page.waitForURL("**/dashboard");
    expect(new URL(page.url()).host).toBe(new URL(test.info().project.use.baseURL!).host);
  });

  test("AUTH-08 public sign-up is disabled at the Auth layer", async () => {
    const email = authEmail(`e2e_signup_${randomBytes(3).toString("hex")}`);
    const { data, error } = await anonClient().auth.signUp({ email, password: `Pw-${randomBytes(8).toString("hex")}` });
    if (data.user) await serviceClient().auth.admin.deleteUser(data.user.id);
    expect(error, "Supabase Auth accepted a public sign-up; disable it in Auth settings").not.toBeNull();
    expect(data.user).toBeNull();
  });

  test("AUTH-09 sign out ends the session", async ({ page }) => {
    // Dedicated user: sign-out revokes every session of that user, so the shared accounts must not be used.
    const username = `e2e_tmp_${randomBytes(3).toString("hex")}`;
    const password = `Pw-${randomBytes(9).toString("hex")}`;
    await createAuthUser({ username, displayName: "E2E Signout", role: "sales", password });

    await signIn(page, username, password);
    await page.waitForURL("**/dashboard");
    await page.getByRole("button", { name: /E2E Signout/ }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.waitForURL("**/login");

    await page.goto("/leads");
    await expect(page).toHaveURL(/\/login\?next=%2Fleads/);
  });

  test("login page shows the deactivated-account message from the redirect", async ({ page }) => {
    await page.goto("/login?error=inactive");
    await expect(formAlert(page)).toHaveText("Your account is deactivated. Contact an admin.");
  });
});
