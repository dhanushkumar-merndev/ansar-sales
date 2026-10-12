import path from "node:path";
import type { Browser, Page } from "@playwright/test";
import { AUTH_DIR, readRun } from "./support/accounts";
import { createLead, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { accessTokenFrom, createGardensUser, serviceClient, tokenClient } from "./support/supabase";
import { dialog, expectRateLimitNotHit, hideDevOverlay, selectOption, signIn, toast } from "./support/ui";

/**
 * Star Gardens project flow, end to end, in the "E2E Gardens" test company (projects module on):
 * BDM hands a lead over → admin creates the project with the team → designer uploads and sends
 * for review → architect manager approves and creates the client login → the client sees only the
 * approved version and approves it → accounts records a payment. Teardown deletes all of it.
 */
const PEOPLE = {
  admin: { username: "e2e_sg_admin", displayName: "E2E SG Admin", role: "admin" },
  bdm: { username: "e2e_sg_bdm", displayName: "E2E SG BDM", role: "sales" },
  manager: { username: "e2e_sg_manager", displayName: "E2E SG Manager", role: "architect_manager" },
  designer: { username: "e2e_sg_designer", displayName: "E2E SG Designer", role: "landscape_designer" },
  account: { username: "e2e_sg_account", displayName: "E2E SG Account", role: "account" },
} as const;
type Person = keyof typeof PEOPLE;

const statePath = (p: Person) => path.join(AUTH_DIR, `sg_${p}.json`);
const ids = {} as Record<Person, string>;
let password = "";

async function pageAs(browser: Browser, baseURL: string | undefined, p: Person | { storageState?: undefined }) {
  const context = await browser.newContext({ baseURL, storageState: typeof p === "string" ? statePath(p) : undefined, viewport: { width: 1360, height: 900 } });
  await hideDevOverlay(context);
  return context.newPage();
}

async function signedIn(page: Page, username: string) {
  await signIn(page, username, password);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 120_000 }).catch(async (e) => {
    await expectRateLimitNotHit(page);
    throw e;
  });
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/MediaBox[0 0 200 200]/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

test.describe.configure({ mode: "serial" });

test.describe("Star Gardens projects", () => {
  // Opt-in: six more sign-ins would push a full run past Supabase's sign-in rate limit.
  test.skip(process.env.E2E_PROJECTS !== "1", "set E2E_PROJECTS=1 (run on its own: E2E_PROJECTS=1 pnpm test:e2e projects)");
  const t = tag("E2E SG");
  const leadName = `${t} Hari`;
  const projectName = `${t} Residence`;
  const fileName = `${t.replace(/\s/g, "-")}-layout.pdf`;
  const client = { username: `e2e_sgc_${t.split(" ").pop()}`, name: `${t} Client` };
  let leadId = "";
  let projectId = "";

  test.beforeAll(async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    password = readRun().password;
    for (const p of Object.keys(PEOPLE) as Person[]) {
      ids[p] = await createGardensUser({ ...PEOPLE[p], password });
      const page = await pageAs(browser, baseURL, {});
      await signedIn(page, PEOPLE[p].username);
      await page.context().storageState({ path: statePath(p) });
      await page.context().close();
    }
  });

  test("PRJ-01 BDM hands an interested lead to the admins", async ({ browser, baseURL }) => {
    // Created through the same RPC the app uses, as the BDM (RLS applies).
    leadId = (await createLead(as("bdm"), { name: leadName, niche: { newName: `${t} Landscape` } })).id;
    const page = await pageAs(browser, baseURL, "bdm");

    await page.goto(`/leads/${leadId}`);
    await page.getByRole("button", { name: "Hand over to Admin" }).click();
    const d = dialog(page, `Hand ${leadName} to Admin?`);
    await d.getByLabel("Handover note").fill("Wants a garden with a pergola, 65×12 ft");
    await d.getByRole("button", { name: "Hand over", exact: true }).click();
    await expect(toast(page, "Handed over to the admins")).toBeVisible();
    await expect(page.getByText(/Handed to admin/)).toBeVisible();
    await page.context().close();
  });

  test("PRJ-02 admin creates the project with the team and the template", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "admin");
    await page.goto("/projects");
    await expect(page.getByText(leadName).first()).toBeVisible();

    await page.goto(`/leads/${leadId}`);
    await page.getByRole("button", { name: "Create project" }).click();
    const d = dialog(page, `New project for ${leadName}`);
    await d.locator("#p-name").fill(projectName);
    await d.locator("#p-value").fill("100000");
    await d.getByRole("button", { name: "Next" }).click();
    await selectOption(page, d.locator("#p-am"), PEOPLE.manager.displayName);
    await d.getByText(PEOPLE.designer.displayName, { exact: true }).click();
    await d.getByRole("button", { name: "Create project" }).click();
    await expect(toast(page, `Project "${projectName}" created`)).toBeVisible();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
    projectId = page.url().match(/\/projects\/([0-9a-f-]{36})/)![1];
    await expect(page.getByRole("heading", { level: 1, name: projectName })).toBeVisible();

    const sb = serviceClient();
    const { data: phases } = await sb.from("project_phases").select("id").eq("project_id", projectId);
    expect(phases?.length).toBeGreaterThan(5);
    const { data: members } = await sb.from("project_members").select("user_id, member_role").eq("project_id", projectId).is("removed_at", null);
    expect(members).toEqual(expect.arrayContaining([
      { user_id: ids.manager, member_role: "architect_manager" },
      { user_id: ids.designer, member_role: "landscape_designer" },
    ]));
    await page.context().close();
  });

  test("PRJ-03 BDM and designer get only what their role allows", async () => {
    expect((await as("bdm").from("projects").select("id").eq("id", projectId)).data).toEqual([]);
    const designer = as("designer");
    expect((await designer.from("projects").select("id").eq("id", projectId)).data).toHaveLength(1);
    expect((await designer.from("project_payments").select("id").eq("project_id", projectId)).data).toEqual([]);
    expect((await designer.from("project_financials").select("contract_value").eq("project_id", projectId)).data).toEqual([]);
  });

  test("PRJ-04 designer uploads to Tigris and sends the drawing for review", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "designer");
    await page.goto(`/projects/${projectId}?tab=files`);
    await page.getByRole("navigation", { name: "Folders" }).getByText("Layout & deck").click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload" }).click();
    await (await chooser).setFiles({ name: fileName, mimeType: "application/pdf", buffer: PDF });
    await expect(toast(page, `${fileName} uploaded to Layout & deck`)).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: new RegExp(fileName) }).click();
    await page.getByRole("button", { name: "Send for review" }).click();
    await expect(toast(page, "Sent for review")).toBeVisible();
    await page.context().close();

    // Not approved yet: nothing for a client.
    const { data } = await serviceClient().from("project_file_versions").select("status").eq("project_id", projectId);
    expect(data).toEqual([{ status: "submitted" }]);
  });

  test("PRJ-05 architect manager approves and creates the client login", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "manager");
    await page.goto(`/projects/${projectId}?tab=files`);
    await page.getByRole("navigation", { name: "Folders" }).getByText("Layout & deck").click();
    await page.getByRole("button", { name: new RegExp(fileName) }).click();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(toast(page, "Approved — the client can see it now")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.goto(`/projects/${projectId}`);
    await page.getByRole("button", { name: "Login" }).click();
    const d = dialog(page, "Client portal login");
    await d.locator("#cl-user").fill(client.username);
    await d.locator("#cl-name").fill(client.name);
    await d.locator("#cl-pass").fill(password);
    await d.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Client login created")).toBeVisible();
    await expect(page.getByText(`@${client.username}`)).toBeVisible();
    await page.context().close();
  });

  test("PRJ-06 the client sees the approved drawing in the portal and approves it", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, {});
    await signedIn(page, client.username);
    await page.waitForURL(/\/portal/);
    await expect(page.getByText(projectName).first()).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: fileName });
    await expect(row).toContainText("Please review");
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(toast(page, "Thank you — approved")).toBeVisible();
    await expect(row).toContainText("You approved");
    // The client never reads the tables directly.
    await page.context().close();

    const { data } = await serviceClient().from("project_file_versions").select("status").eq("project_id", projectId);
    expect(data).toEqual([{ status: "client_approved" }]);
  });

  test("PRJ-07 accounts records the advance; the schedule takes it oldest part first", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "account");
    await page.goto(`/projects/${projectId}?tab=payments`);
    await page.getByRole("button", { name: "Record payment" }).click();
    const d = dialog(page, "Record payment");
    // Suggests what is due now (the advance) and shows where the money goes.
    await expect(d.locator("#pm-for")).toContainText("The payment schedule");
    await expect(d.locator("#pm-amount")).toHaveValue("30000");
    await expect(d.getByText("· cleared")).toBeVisible();
    await selectOption(page, d.locator("#pm-mode"), "UPI");
    await d.locator("#pm-ref").fill("UTR-E2E-1");
    await d.getByRole("button", { name: "Record", exact: true }).click();
    await expect(toast(page, /recorded$/)).toBeVisible();
    await page.context().close();

    const { data } = await serviceClient().from("project_payments").select("amount, mode").eq("project_id", projectId).is("archived_at", null);
    expect(data?.map((p) => [Number(p.amount), p.mode])).toEqual([[30000, "upi"]]);
    // The architect manager never sees money.
    const { error } = await as("manager").rpc("project_payment_status", { p_project_id: projectId });
    expect(error?.message).toMatch(/forbidden/);
  });
});

/** REST client acting as a signed-in Gardens user (RLS applies). */
const as = (p: Person) => tokenClient(accessTokenFrom(statePath(p)));
