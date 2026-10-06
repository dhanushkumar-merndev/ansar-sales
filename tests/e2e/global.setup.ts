import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { expect, test as setup } from "@playwright/test";
import { ACCOUNT_KEYS, ACCOUNTS, type AccountKey, readRun, storageState, writeRun } from "./support/accounts";
import { cleanupE2EData, createAuthUser, serviceClient } from "./support/supabase";
import { expectRateLimitNotHit, signIn } from "./support/ui";

/** Local iteration: E2E_REUSE_SESSIONS=1 + E2E_KEEP_DATA=1 skips re-provisioning while the saved sessions are fresh. */
async function reusableSessions() {
  if (process.env.E2E_REUSE_SESSIONS !== "1") return false;
  try {
    const run = readRun();
    const fresh = ACCOUNT_KEYS.every((k) => Date.now() - fs.statSync(storageState(k)).mtimeMs < 45 * 60_000);
    const { data } = await serviceClient().from("profiles").select("id").in("id", Object.values(run.ids)).eq("is_active", true);
    return fresh && data?.length === ACCOUNT_KEYS.length;
  } catch {
    return false;
  }
}

setup("provision e2e accounts and sign each one in", async ({ browser, baseURL }) => {
  setup.setTimeout(300_000);
  if (await reusableSessions()) return;

  // Leftovers from an interrupted run would make counts and usernames collide.
  const removed = await cleanupE2EData();
  if (removed.users) console.log(`[e2e] removed leftovers from a previous run:`, removed);

  const password = `E2e-${randomBytes(12).toString("base64url")}`;
  const ids = {} as Record<AccountKey, string>;
  for (const key of ACCOUNT_KEYS) ids[key] = await createAuthUser({ ...ACCOUNTS[key], password });
  writeRun({ runId: randomBytes(4).toString("hex"), password, ids });

  // Real UI sign-in once per role; specs reuse the saved session cookies.
  for (const key of ACCOUNT_KEYS) {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await signIn(page, ACCOUNTS[key].username, password);
    await page.waitForURL(/\/dashboard/, { timeout: 120_000 }).catch(async (e) => {
      await expectRateLimitNotHit(page);
      throw e;
    });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 60_000 });
    await context.storageState({ path: storageState(key) });
    await context.close();
  }
});
