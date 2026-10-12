import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createUser, one, type Db } from "./harness";

// Companies whose ads Star Growth Hub runs: no ads users and no Meta lead-form management there.
let db: Db;
let gardens: string, sgAdmin: string, superAdmin: string, hubAdmin: string;

beforeAll(async () => {
  db = await createDb();
  gardens = await createCompany(db, "Star Gardens 2");
  sgAdmin = await createUser(db, "nogo_admin", "admin", "SG Admin", gardens);
  hubAdmin = await createUser(db, "hub_admin", "admin", "Hub Admin");
  superAdmin = await createUser(db, "nogo_super", "super_admin" as never, "Super");
});

const isAds = (uid: string) => asUser(db, uid, async (tx) => (await one<{ r: boolean }>(tx, "select private.is_ads_user() as r")).r);
/** Whether the person may manage the company's Facebook Lead Ads (through a function that checks it). */
const canMeta = (uid: string, company: string) => asUser(db, uid, (tx) => tx.query("select public.delete_meta_integration($1)", [company])).then(() => true, () => false);

describe("no_ads companies", () => {
  it("switch off ads and Facebook lead automation for the company — in the database", async () => {
    expect(await isAds(sgAdmin)).toBe(true);
    await asUser(db, superAdmin, (tx) => tx.query("select public.set_company_feature($1, 'no_ads', true)", [gardens]));
    expect(await isAds(sgAdmin)).toBe(false);
    expect(await canMeta(sgAdmin, gardens)).toBe(false);
    // Other companies keep theirs.
    expect(await isAds(hubAdmin)).toBe(true);
    // Only the super admin switches it, and it can be switched back on.
    await expect(asUser(db, sgAdmin, (tx) => tx.query("select public.set_company_feature($1, 'no_ads', false)", [gardens]))).rejects.toThrow(/forbidden/);
    await asUser(db, superAdmin, (tx) => tx.query("select public.set_company_feature($1, 'no_ads', false)", [gardens]));
    expect(await isAds(sgAdmin)).toBe(true);
    await expect(asUser(db, superAdmin, (tx) => tx.query("select public.set_company_feature($1, 'everything', true)", [gardens]))).rejects.toThrow(/invalid_feature/);
  });

  it("switches Star Gardens off when the migration runs", async () => {
    // Re-run the migration's update against a company named Star Gardens (the test database has none at migration time).
    const sg = await createCompany(db, "Star Gardens");
    const sql = (await import("node:fs")).readFileSync(new URL("../../supabase/migrations/20261008001900_company_no_ads.sql", import.meta.url), "utf8");
    await db.exec(sql.slice(sql.lastIndexOf("update public.companies")));
    const r = await db.query<{ f: string[] }>("select features as f from public.companies where id = $1", [sg]);
    expect(r.rows[0].f).toContain("no_ads");
  });
});
