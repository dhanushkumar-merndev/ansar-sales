import type { Page } from "@playwright/test";
import { readRun, storageState } from "./support/accounts";
import { addFollowUp, createLead, ist, minutesFromNow, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { serviceClient, userClient } from "./support/supabase";
import { dialog, readCount, timelineItems, toast } from "./support/ui";

// The browser runs in America/New_York (see playwright.config.ts); every time below is IST.
test.use({ storageState: storageState("salesA") });

const upcoming = (page: Page) => page.locator('[data-slot="card"]').filter({ has: page.getByText("Upcoming follow-ups", { exact: true }) });

function istTomorrow() {
  const d = new Date(`${ist(new Date()).date}T12:00:00+05:30`);
  d.setUTCDate(d.getUTCDate() + 1);
  return ist(d).date;
}
const istInstant = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

async function leadWithFollowUp(t: string, due: Date) {
  const a = userClient("salesA");
  const { id } = await createLead(a, { name: `${t} Lead` });
  const fu = await addFollowUp(a, readRun().ids.salesA, id, due, `${t} task`);
  return { id, fu };
}

test.describe("Follow-ups", () => {
  test("FU-01/07 schedule in IST from a non-IST browser; stored as the right UTC instant", async ({ page }) => {
    const t = tag();
    const { id } = await createLead(userClient("salesA"), { name: `${t} Lead` });
    await page.goto(`/leads/${id}`);
    await upcoming(page).getByRole("button", { name: "Schedule" }).click();
    const d = dialog(page, "Schedule follow-up");
    await d.locator("#fu-task").fill(`${t} call about pricing`);
    await d.locator("#fu-time").fill("10:30");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Follow-up scheduled")).toBeVisible();

    const item = upcoming(page).locator("li").filter({ hasText: `${t} call about pricing` });
    await expect(item).toContainText(/10:30\s?am/i);
    await expect(timelineItems(page).first()).toContainText("scheduled a follow-up");

    const { data } = await serviceClient().from("follow_ups").select("due_at, assignee_id, state").eq("lead_id", id).single();
    expect(new Date(data!.due_at).toISOString()).toBe(istInstant(istTomorrow(), "10:30").toISOString());
    expect(data).toMatchObject({ assignee_id: readRun().ids.salesA, state: "pending" });
  });

  test("FU-02 empty task and past times are rejected in the dialog", async ({ page }) => {
    const t = tag();
    const { id } = await createLead(userClient("salesA"), { name: `${t} Lead` });
    await page.goto(`/leads/${id}`);
    await upcoming(page).getByRole("button", { name: "Schedule" }).click();
    const d = dialog(page, "Schedule follow-up");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d.getByText("Describe the task.")).toBeVisible();

    await d.locator("#fu-task").fill(`${t} too late`);
    await d.locator("#fu-date").click();
    await page.locator(".rdp-today button, [data-today] button").first().click();
    await d.locator("#fu-time").fill("00:00");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d.getByText("Choose a time in the future.")).toBeVisible();
    const { count } = await serviceClient().from("follow_ups").select("id", { count: "exact", head: true }).eq("lead_id", id);
    expect(count).toBe(0);
  });

  test("FU-03 reschedule moves the time and supersedes the old reminder revision", async ({ page }) => {
    const t = tag();
    const { id, fu } = await leadWithFollowUp(t, istInstant(istTomorrow(), "12:00"));
    await page.goto(`/leads/${id}`);
    await upcoming(page).getByRole("button", { name: "Reschedule" }).click();
    const d = dialog(page, "Reschedule follow-up");
    await expect(d.locator("#fu-task")).toHaveValue(`${t} task`);
    await expect(d.locator("#fu-time")).toHaveValue("12:00");
    await d.locator("#fu-time").fill("11:45");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Follow-up rescheduled")).toBeVisible();
    await expect(upcoming(page)).toContainText(/11:45\s?am/i);
    await expect(timelineItems(page).first()).toContainText("rescheduled a follow-up");

    const { data } = await serviceClient().from("reminder_deliveries").select("revision, state, last_error").eq("follow_up_id", fu).order("revision");
    expect(data).toEqual([
      { revision: 1, state: "cancelled", last_error: "superseded" },
      { revision: 2, state: "pending", last_error: null },
    ]);
  });

  test("FU-04 complete with an outcome and schedule the next one", async ({ page }) => {
    const t = tag();
    const { id, fu } = await leadWithFollowUp(t, minutesFromNow(180));
    await page.goto(`/leads/${id}`);
    await upcoming(page).getByRole("button", { name: "Complete" }).click();
    const d = dialog(page, "Complete follow-up");
    await d.locator("#fu-outcome").fill(`${t} wants a proposal`);
    await d.getByLabel("Schedule the next follow-up").check();
    await d.locator("#fu-next-task").fill(`${t} send proposal`);
    await d.getByRole("button", { name: "Mark complete" }).click();
    await expect(toast(page, "Follow-up completed")).toBeVisible();

    await expect(upcoming(page)).toContainText(`${t} send proposal`);
    await expect(upcoming(page)).not.toContainText(`${t} task`);
    const done = timelineItems(page).filter({ hasText: "completed a follow-up" });
    await expect(done).toContainText(`Outcome: ${t} wants a proposal`);

    const { data } = await serviceClient().from("follow_ups").select("state, outcome").eq("id", fu).single();
    expect(data).toEqual({ state: "completed", outcome: `${t} wants a proposal` });

    await page.goto(`/follow-ups?view=completed&q=${encodeURIComponent(t)}`);
    await expect(page.getByText(`${t} task`)).toBeVisible();
    await expect(page.getByText("Outcome: " + `${t} wants a proposal`)).toBeVisible();
  });

  test("FU-05 cancel requires confirmation and is logged", async ({ page }) => {
    const t = tag();
    const { id } = await leadWithFollowUp(t, minutesFromNow(240));
    await page.goto(`/leads/${id}`);
    await upcoming(page).getByRole("button", { name: "Cancel", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: "Cancel this follow-up?" });
    await confirm.getByRole("button", { name: "Cancel follow-up" }).click();
    await expect(toast(page, "Follow-up cancelled")).toBeVisible();
    await expect(upcoming(page)).toContainText("No pending follow-ups.");
    await expect(timelineItems(page).first()).toContainText("cancelled a follow-up");
  });

  test("FU-06 overdue is derived from the due time everywhere", async ({ page }) => {
    const t = tag();
    const before = await (async () => {
      await page.goto("/dashboard");
      return readCount(page, "Overdue tasks");
    })();
    const { id } = await leadWithFollowUp(t, minutesFromNow(-90));

    await page.goto(`/leads/${id}`);
    await expect(upcoming(page).getByText("Overdue")).toBeVisible();

    await page.goto(`/follow-ups?view=overdue&q=${encodeURIComponent(t)}`);
    await expect(page.getByRole("link", { name: `${t} Lead` })).toBeVisible();
    await page.goto(`/follow-ups?view=upcoming&q=${encodeURIComponent(t)}`);
    await expect(page.getByText("No follow-ups here")).toBeVisible();

    await page.goto(`/leads?overdue=1&q=${encodeURIComponent(t)}`);
    await expect(page.getByRole("link", { name: `${t} Lead` })).toBeVisible();

    await page.goto("/dashboard");
    await expect.poll(() => readCount(page, "Overdue tasks")).toBe(before + 1);
  });
});
