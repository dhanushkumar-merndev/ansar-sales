import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createLead, createUser, one, type Db } from "./harness";

let db: Db;
let admin: string, admin2: string, sales: string, account: string, otherAdmin: string;
let otherLead: string;

type Row = { id: string; name: string; phone: string; stage: string; owner: string; niche: string; created_at: string };
const page = (user: string, onlyNew: boolean, after: Row | null = null, limit = 1000) =>
  asUser(db, user, async (tx) => (await one<{ r: Row[] }>(tx,
    "select public.export_leads(p_only_new => $1, p_after_created => $2, p_after_id => $3, p_limit => $4) as r",
    [onlyNew, after?.created_at ?? null, after?.id ?? null, limit])).r);
const mark = (user: string, ids: string[]) =>
  asUser(db, user, async (tx) => (await one<{ n: number }>(tx, "select public.mark_leads_exported($1::uuid[]) as n", [ids])).n);
const pending = (user: string) =>
  asUser(db, user, async (tx) => (await one<{ n: number }>(tx, "select public.lead_export_pending() as n")).n);

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "exp_admin", "admin", "Exp Admin");
  admin2 = await createUser(db, "exp_admin2", "admin", "Exp Admin 2");
  sales = await createUser(db, "exp_sales", "sales", "Exp Sales");
  account = await createUser(db, "exp_account", "account", "Exp Account");
  const other = await createCompany(db, "Elsewhere");
  otherAdmin = await createUser(db, "exp_other", "admin", "Other Admin", other);
  for (const name of ["One", "Two", "Three"]) await createLead(db, sales, { name });
  otherLead = await createLead(db, otherAdmin, { name: "Not ours" });
});

describe("leads download", () => {
  it("is for admins only", async () => {
    for (const u of [sales, account]) {
      await expect(page(u, false)).rejects.toThrow(/forbidden/);
      await expect(mark(u, [])).rejects.toThrow(/forbidden/);
      await expect(pending(u)).rejects.toThrow(/forbidden/);
    }
  });

  it("downloads every active lead of the company, oldest first, with readable columns", async () => {
    const all = await page(admin, false);
    expect(all.map((r) => r.name)).toEqual(["One", "Two", "Three"]);
    expect(all[0]).toMatchObject({ owner: "Exp Sales", niche: "Retail", stage: expect.any(String) });
    expect(all[0].phone).toMatch(/^\+91/);
  });

  it("pages by key without skipping or repeating", async () => {
    const first = await page(admin, false, null, 2);
    const second = await page(admin, false, first.at(-1)!, 2);
    expect([...first, ...second].map((r) => r.name)).toEqual(["One", "Two", "Three"]);
    await expect(asUser(db, admin, (tx) => tx.query("select public.export_leads(p_limit => 1001)"))).rejects.toThrow(/invalid_page/);
  });

  it("'new' gives only what this admin hasn't downloaded, separately per admin", async () => {
    expect(await pending(admin)).toBe(3);
    const all = await page(admin, false);
    expect(await mark(admin, all.map((r) => r.id))).toBe(3);
    expect(await pending(admin)).toBe(0);
    expect(await page(admin, true)).toEqual([]);

    await createLead(db, sales, { name: "Four" });
    expect((await page(admin, true)).map((r) => r.name)).toEqual(["Four"]);
    expect(await pending(admin)).toBe(1);
    // The other admin has downloaded nothing yet.
    expect(await pending(admin2)).toBe(4);
    // Marking twice is harmless.
    expect(await mark(admin, all.map((r) => r.id))).toBe(0);
  });

  it("ignores leads of another company and leaves out archived ones", async () => {
    expect(await mark(admin, [otherLead])).toBe(0);
    expect((await page(admin, false)).map((r) => r.name)).not.toContain("Not ours");
    const four = (await page(admin, true))[0];
    await db.query("update public.leads set archived_at = now() where id = $1", [four.id]);
    expect(await page(admin, true)).toEqual([]);
    expect(await pending(admin)).toBe(0);
  });
});

describe("leads download for chosen dates", () => {
  const between = (from: string | null, before: string | null) =>
    asUser(db, admin, async (tx) => (await one<{ r: Row[] }>(tx,
      "select public.export_leads(p_created_from => $1, p_created_before => $2) as r", [from, before])).r);
  const hour = 3_600_000;
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();

  it("only has the leads added in the range, still only this company's", async () => {
    const inRange = await between(at(-hour), at(hour));
    expect(inRange.map((l) => l.name).sort()).toEqual(["One", "Three", "Two"]);
    expect(await between(at(hour), null)).toEqual([]);
    expect(await between(null, at(-hour))).toEqual([]);
  });
});
