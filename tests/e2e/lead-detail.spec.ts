import { readRun, storageState } from "./support/accounts";
import { createLead, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { userClient } from "./support/supabase";
import { dialog, selectOption, timelineItems, toast, waitForLive } from "./support/ui";

test.use({ storageState: storageState("salesA") });

async function newLead(name: string, extra: Omit<Parameters<typeof createLead>[1], "name"> = {}) {
  return (await createLead(userClient("salesA"), { name, ...extra })).id;
}

test.describe("Lead detail, notes and timeline", () => {
  test("TL-01/02 notes via button and Ctrl+Enter, newest first, empty note blocked", async ({ page }) => {
    const t = tag();
    const id = await newLead(`${t} Notes`);
    await page.goto(`/leads/${id}`);
    await expect(page.getByRole("heading", { name: `${t} Notes`, level: 1 })).toBeVisible();

    const note = page.getByLabel("Add note");
    const save = page.getByRole("button", { name: "Save note" });
    await expect(save).toBeDisabled();
    await note.fill("   ");
    await expect(save).toBeDisabled();

    await note.fill(`${t} first note`);
    await save.click();
    await expect(toast(page, "Note added")).toBeVisible();
    await expect(note).toHaveValue("");

    await note.fill(`${t} second note`);
    await note.press("Control+Enter");
    const items = timelineItems(page);
    await expect(items.first()).toContainText(`${t} second note`);
    await expect(items.first()).toContainText("E2E Sales A added a note");
    await expect(items.nth(1)).toContainText(`${t} first note`);
    await expect(items.last()).toContainText("created the lead");
  });

  test("TL-03 correcting a note keeps the original text in history", async ({ page }) => {
    const t = tag();
    const id = await newLead(`${t} Correct`, { note: `${t} orignal typo` });
    await page.goto(`/leads/${id}`);
    const noteItem = timelineItems(page).filter({ hasText: `${t} orignal typo` });
    await noteItem.getByRole("button", { name: "Correct" }).click();
    const d = dialog(page, "Correct note");
    await d.getByLabel("Note").fill(`${t} original, fixed`);
    await d.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Note corrected")).toBeVisible();

    await expect(timelineItems(page).filter({ hasText: "added a note (edited)" })).toContainText(`${t} original, fixed`);
    await expect(timelineItems(page).filter({ hasText: "corrected a note" })).toContainText(`${t} orignal typo`);
  });

  test("TL-04 status change is logged with old and new values", async ({ page }) => {
    const t = tag();
    const id = await newLead(`${t} Status`);
    await page.goto(`/leads/${id}`);
    await selectOption(page, page.getByRole("combobox", { name: "Change status" }), "Contacted");
    await expect(toast(page, "Status: Contacted")).toBeVisible();
    await expect(timelineItems(page).first()).toContainText("changed status from New to Contacted");
  });

  test("TL-05 editing details logs readable old → new values", async ({ page }) => {
    const t = tag();
    const id = await newLead(`${t} Before`);
    await page.goto(`/leads/${id}`);
    await page.getByRole("button", { name: "Edit" }).click();
    const d = dialog(page, "Edit lead");
    await d.locator("#lead-name").fill(`${t} After`);
    await d.locator("#lead-email").fill(`edit.${t.split(" ")[1]}@example.com`);
    await d.getByRole("button", { name: "Save changes" }).click();
    await expect(toast(page, "Lead updated")).toBeVisible();
    await expect(page.getByRole("heading", { name: `${t} After`, level: 1 })).toBeVisible();
    const entry = timelineItems(page).filter({ hasText: "updated details" });
    await expect(entry).toContainText(`Name: ${t} Before → ${t} After`);
    await expect(entry).toContainText("Email: — →");
  });

  test("LEAD-18 a concurrent change is flagged and the stale save is rejected", async ({ page }) => {
    const t = tag();
    const id = await newLead(`${t} Conflict`);
    await page.goto(`/leads/${id}`);
    await waitForLive(page);
    await page.getByRole("button", { name: "Edit" }).click();
    const d = dialog(page, "Edit lead");
    await d.locator("#lead-name").fill(`${t} My edit`);

    // Someone else changes the lead while the dialog is open.
    await userClient("salesA").from("leads").update({ status: "interested" } as never).eq("id", id);
    await expect(d.getByText("This lead was changed by someone else while you were editing")).toBeVisible({ timeout: 20_000 });
    await expect(d.locator("#lead-name")).toHaveValue(`${t} My edit`); // background refresh kept the input

    await d.getByRole("button", { name: "Save changes" }).click();
    await expect(toast(page, /changed by someone else\. Review the latest details/)).toBeVisible();
    await expect(d).toBeVisible(); // stays open with the user's edit
  });

  test("TL-08/09 long timelines paginate and never show raw JSON", async ({ page }) => {
    const t = tag();
    const id = await newLead(`${t} Long`);
    const a = userClient("salesA");
    const actor = readRun().ids.salesA;
    const notes = Array.from({ length: 22 }, (_, i) => ({ lead_id: id, type: "note", body: `${t} note ${i + 1}`, actor_id: actor }));
    for (const n of notes) await a.from("lead_activities").insert(n as never);

    await page.goto(`/leads/${id}`);
    await expect(timelineItems(page)).toHaveCount(20);
    await expect(timelineItems(page).first()).toContainText(`${t} note 22`);
    await page.getByRole("button", { name: "Show older activity" }).click();
    await expect(timelineItems(page)).toHaveCount(23);
    await expect(timelineItems(page).last()).toContainText("created the lead");
    await expect(page.getByRole("button", { name: "Show older activity" })).toHaveCount(0);

    const activity = await page.locator('[data-slot="card"]').filter({ has: page.getByText("Activity", { exact: true }) }).innerText();
    expect(activity).not.toMatch(/[{}]|"\w+":/);
  });
});
