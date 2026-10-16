import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createLead, createUser, defaultCompany, one, rows, type Db } from "./harness";

let db: Db;
let hub: string, farm: string, coorg: string, ws: string;
let owner: string, adminHub: string, salesA: string, salesB: string, adminFarm: string, salesFarm: string, adminSales: string;
let farmLead: string;

type Context = { company_id: string; roles: string[]; visiting: boolean };
const ctx = (user: string) => asUser(db, user, async (tx) => (await one<{ r: Context }>(tx, "select public.my_context() as r")).r);
const switchTo = (user: string, company: string) => asUser(db, user, (tx) => tx.query("select public.set_active_company($1)", [company]));
const tick = (user: string, companies: string[], actor = owner) =>
  asUser(db, actor, (tx) => tx.query("select public.set_sales_user_companies($1, $2::uuid[])", [user, companies]));
const leadNames = (user: string) => asUser(db, user, async (tx) =>
  (await one<{ r: { items: { name: string }[] } }>(tx, "select public.list_leads(p_limit => 100) as r")).r.items.map((l) => l.name).sort());
const companiesSeen = (user: string) => asUser(db, user, async (tx) => (await rows<{ id: string }>(tx, "select id from public.companies")).map((r) => r.id));
const leadCompany = (user: string, lead: string) =>
  asUser(db, user, async (tx) => (await one<{ r: { id: string } | null }>(tx, "select public.lead_company($1) as r", [lead])).r);

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  farm = await createCompany(db, "Star Managed Farmlands");
  coorg = await createCompany(db, "Land in Coorg");
  owner = await createUser(db, "owner", "super_admin");
  adminHub = await createUser(db, "admin_hub", "admin", "Admin Hub");
  salesA = await createUser(db, "sales_a", "sales", "Sales A");
  salesB = await createUser(db, "sales_b", "sales", "Sales B");
  adminSales = await createUser(db, "admin_sales", "admin", "Admin Sales");
  await db.query("update public.profiles set extra_roles = '{sales}' where id = $1", [adminSales]);
  adminFarm = await createUser(db, "admin_farm", "admin", "Admin Farm", farm);
  salesFarm = await createUser(db, "sales_farm", "sales", "Sales Farm", farm);
  ws = await asUser(db, adminHub, async (tx) => {
    const client = (await one<{ id: string }>(tx, "select public.create_ads_client('Ashok') as id")).id;
    return (await one<{ id: string }>(tx, "select public.open_ads_client_crm($1) as id", [client])).id;
  });
  await createLead(db, salesA, { name: "Hub lead A" });
  await createLead(db, adminFarm, { name: "Farm lead of Sales Farm", ownerId: salesFarm });
});

describe("ticking companies for a sales user", () => {
  it("only the super admin can, and only for other companies of ours", async () => {
    await expect(tick(salesA, [farm], adminHub)).rejects.toThrow(/forbidden/);
    await expect(tick(salesA, [hub])).rejects.toThrow(/not_found/);
    await expect(tick(salesA, [ws])).rejects.toThrow(/not_found/);
    await expect(tick(adminHub, [farm])).rejects.toThrow(/not_found/);
    await tick(salesA, [farm, coorg]);
    const list = await asUser(db, owner, async (tx) =>
      (await one<{ r: { id: string; company_id: string; company_ids: string[] }[] }>(tx, "select public.super_list_sales_users() as r")).r);
    expect(list.find((u) => u.id === salesA)).toMatchObject({ company_id: hub, company_ids: [farm, coorg] });
    expect(list.find((u) => u.id === salesB)).toMatchObject({ company_ids: [] });
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.super_list_sales_users()"))).rejects.toThrow(/forbidden/);
  });
});

describe("working in another company", () => {
  it("switches between home and the ticked companies only, as Sales", async () => {
    expect((await companiesSeen(salesA)).sort()).toEqual([hub, farm, coorg].sort());
    expect(await companiesSeen(salesB)).toEqual([hub]);
    await expect(switchTo(salesB, farm)).rejects.toThrow(/forbidden/);
    await switchTo(salesA, farm);
    expect(await ctx(salesA)).toMatchObject({ company_id: farm, roles: ["sales"], visiting: true });
  });

  it("owns leads there, sees only those, and is a pickable owner for that company's admin", async () => {
    farmLead = (await createLead(db, adminFarm, { name: "Farm lead of Sales A", ownerId: salesA }));
    await createLead(db, salesA, { name: "Added by Sales A at the farm" });
    expect(await leadNames(salesA)).toEqual(["Added by Sales A at the farm", "Farm lead of Sales A"]);
    const own = await one<{ company_id: string; owner_id: string }>(db, "select company_id, owner_id from public.leads where name = 'Added by Sales A at the farm'");
    expect(own).toEqual({ company_id: farm, owner_id: salesA });
    const staff = await asUser(db, adminFarm, async (tx) => (await rows<{ id: string }>(tx, "select id from public.profiles where role in ('sales', 'admin')")).map((r) => r.id));
    expect(staff).toContain(salesA);
    expect(staff).not.toContain(salesB);
    // Back home: only home leads, and Telegram links into the farm still find the right company.
    await switchTo(salesA, hub);
    expect(await ctx(salesA)).toMatchObject({ company_id: hub, visiting: false });
    expect(await leadNames(salesA)).toEqual(["Hub lead A"]);
    expect((await leadCompany(salesA, farmLead))?.id).toBe(farm);
    expect(await leadCompany(salesB, farmLead)).toBeNull();
  });

  it("an admin with a sales role at home is only Sales in the other company", async () => {
    await tick(adminSales, [farm]);
    await switchTo(adminSales, farm);
    expect(await ctx(adminSales)).toMatchObject({ company_id: farm, roles: ["sales"], visiting: true });
    expect(await leadNames(adminSales)).toEqual([]);
    await switchTo(adminSales, hub);
    expect((await ctx(adminSales)).roles).toContain("admin");
  });
});

describe("Facebook lead routing", () => {
  it("takes the visiting sales user, and new leads go to them", async () => {
    await asUser(db, adminFarm, (tx) => tx.query("select public.save_meta_integration($1, '1234567', '7654321', 'x', 'y')", [farm]));
    await expect(asUser(db, adminFarm, (tx) => tx.query("select public.set_meta_routing($1, $2::uuid[])", [farm, [salesB]]))).rejects.toThrow(/invalid_owner/);
    await asUser(db, adminFarm, (tx) => tx.query("select public.set_meta_routing($1, $2::uuid[])", [farm, [salesA]]));
    const overview = await asUser(db, owner, async (tx) =>
      (await one<{ r: { company_id: string; candidates: { id: string }[] }[] }>(tx, "select public.super_meta_overview() as r")).r);
    expect(overview.find((c) => c.company_id === farm)?.candidates.map((c) => c.id)).toContain(salesA);
    const r = await asService(db, async (tx) => (await one<{ r: { state: string; owner_id: string; company_id: string } }>(tx,
      "select public.ingest_meta_lead(p_company_id => $1, p_leadgen_id => '555001', p_name => 'Ravi', p_phone => '+919812300001', p_phone_normalized => '+919812300001') as r",
      [farm])).r);
    expect(r).toMatchObject({ state: "created", owner_id: salesA, company_id: farm });
  });
});

describe("unticking a company", () => {
  it("ends access at once and takes them out of that company's routing; their leads stay theirs", async () => {
    await switchTo(salesA, farm);
    await tick(salesA, [coorg]);
    expect((await ctx(salesA)).company_id).toBe(hub);
    await expect(switchTo(salesA, farm)).rejects.toThrow(/forbidden/);
    expect(await leadCompany(salesA, farmLead)).toBeNull();
    expect(await rows(db, "select 1 from public.meta_lead_routing where company_id = $1 and user_id = $2", [farm, salesA])).toHaveLength(0);
    expect((await one<{ owner_id: string }>(db, "select owner_id from public.leads where id = $1", [farmLead])).owner_id).toBe(salesA);
    // Without the sales role there is nowhere else to go.
    await db.query("update public.profiles set role = 'account' where id = $1", [salesA]);
    expect(await companiesSeen(salesA)).toEqual([hub]);
  });
});
