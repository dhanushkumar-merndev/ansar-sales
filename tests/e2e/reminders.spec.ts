// Opt-in (E2E_WORKER=1): needs the deployed reminder-worker Edge Function, its secrets
// and the pg_cron job. Waits for a real scheduler run (~1–2 minutes).
import { readRun, storageState } from "./support/accounts";
import { addFollowUp, createLead, minutesFromNow, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { env } from "./support/env";
import { serviceClient, userClient } from "./support/supabase";

test.use({ storageState: storageState("salesA") });

test("FU-10 a due reminder for a user without Telegram is processed by the worker and shown as failed", async ({ page }) => {
  test.skip(!env.runWorker, "set E2E_WORKER=1 to exercise the deployed cron + Edge Function");
  test.setTimeout(240_000);
  const t = tag();
  const a = userClient("salesA");
  const { id } = await createLead(a, { name: `${t} Reminder` });
  const fu = await addFollowUp(a, readRun().ids.salesA, id, minutesFromNow(0.5), `${t} due now`);

  await expect
    .poll(async () => (await serviceClient().from("reminder_deliveries").select("state, last_error").eq("follow_up_id", fu).single()).data, {
      timeout: 200_000,
      intervals: [10_000],
    })
    .toEqual({ state: "failed", last_error: "telegram_not_connected" });

  await page.goto(`/leads/${id}`);
  await expect(page.getByText("Reminder failed: Telegram not connected")).toBeVisible();
});
