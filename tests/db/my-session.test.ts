import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createUser, defaultCompany, one, rows, type Db } from "./harness";

// 20261008005200_my_session: getCurrentProfile reads the session in one request instead of three.
// my_session() must return exactly what the three separate reads return (src/lib/auth.ts), under RLS.

let db: Db;
let hub: string, farm: string, archived: string, ws: string;
let owner: string, adminHub: string, salesA: string, adminSales: string, adsMgr: string, wsSales: string, inactive: string, archivedAdmin: string;

const switchTo = (user: string, company: string) => asUser(db, user, (tx) => tx.query("select public.set_active_company($1)", [company]));
/** JSON as PostgREST would send it (uuid, text[] and enums as strings and arrays). */
const json = (v: unknown) => JSON.parse(JSON.stringify(v));

/** The three reads getCurrentProfile made before my_session, as the user (arrays cast: PGlite returns enum arrays as text). */
async function threeReads(user: string) {
  return asUser(db, user, async (tx) => {
    const profile = (await rows(tx, "select id, username, display_name, role, extra_roles::text[] as extra_roles, is_active from public.profiles where id = $1", [user]))[0] ?? null;
    const companies = await rows(tx,
      "select id, name, brand_highlight, logo_path, features::text[] as features, parent_company_id from public.companies where archived_at is null order by created_at, id");
    const context = (await one<{ r: unknown }>(tx, "select public.my_context() as r")).r;
    return json({ profile, companies, context });
  });
}

const session = (user: string) => asUser(db, user, async (tx) => (await one<{ r: unknown }>(tx, "select public.my_session() as r")).r);

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  farm = await createCompany(db, "Star Managed Farmlands");
  archived = await createCompany(db, "Closed Co");
  owner = await createUser(db, "owner", "super_admin");
  adminHub = await createUser(db, "admin_hub", "admin", "Admin Hub");
  salesA = await createUser(db, "sales_a", "sales", "Sales A");
  adminSales = await createUser(db, "admin_sales", "admin", "Admin Sales");
  await db.query("update public.profiles set extra_roles = '{sales}' where id = $1", [adminSales]);
  adsMgr = await createUser(db, "ads_mgr", "ads_manager", "Ads Manager");
  inactive = await createUser(db, "gone", "sales", "Gone");
  archivedAdmin = await createUser(db, "closed_admin", "admin", "Closed Admin", archived);
  await asUser(db, owner, async (tx) => {
    await tx.query("select public.set_ads_manager_companies($1, $2::uuid[])", [adsMgr, [hub]]);
    await tx.query("select public.set_sales_user_companies($1, $2::uuid[])", [salesA, [farm]]);
  });
  ws = await asUser(db, adminHub, async (tx) => {
    const client = (await one<{ id: string }>(tx, "select public.create_ads_client('Ashok') as id")).id;
    return (await one<{ id: string }>(tx, "select public.open_ads_client_crm($1) as id", [client])).id;
  });
  wsSales = await createUser(db, "ashok_sales", "sales", "Ashok Sales", ws);
  await asService(db, async (tx) => {
    await tx.query("update public.profiles set is_active = false where id = $1", [inactive]);
    await tx.query("update public.companies set archived_at = now() where id = $1", [archived]);
  });
});

describe("my_session", () => {
  it("equals the profile, companies and my_context reads for every kind of user", async () => {
    const cases: [string, string][] = [
      ["super admin", owner], ["admin", adminHub], ["sales", salesA], ["admin with extra sales role", adminSales],
      ["ads manager", adsMgr], ["client CRM member", wsSales], ["inactive user", inactive], ["admin of an archived company", archivedAdmin],
    ];
    for (const [label, user] of cases) expect(await session(user), label).toEqual(await threeReads(user));
  });

  it("follows company switches: super admin, visiting sales user, agency staff inside a client CRM", async () => {
    await switchTo(owner, farm);
    await switchTo(salesA, farm);
    await switchTo(adminHub, ws);
    for (const user of [owner, salesA, adminHub]) expect(await session(user)).toEqual(await threeReads(user));
    expect(await session(salesA)).toMatchObject({ context: { company_id: farm, visiting: true } });
    expect(await session(adminHub)).toMatchObject({ context: { company_id: ws, workspace: { member: false } } });
  });

  it("is closed to signed-out callers", async () => {
    await expect(asUser(db, null, (tx) => tx.query("select public.my_session()"))).rejects.toThrow(/permission denied/);
  });
});
