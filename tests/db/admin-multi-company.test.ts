import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createLead, createUser, defaultCompany, one, rows, type Db } from "./harness";

// 20261008006300_admin_multi_company: the super admin gives an admin other companies of ours as Admin (or a
// sales user as Sales, as 4200 did). In those companies the admin is a full admin and gets the admin alerts.

let db: Db;
let hub: string, farm: string, coorg: string, ws: string;
let owner: string, adminHub: string, adminSales: string, salesA: string, adminFarm: string, salesFarm: string, accountFarm: string;

type Context = { company_id: string; roles: string[]; visiting: boolean; visiting_role: string | null };
type Access = { company_id: string; role: "sales" | "admin" };
type TeamUser = { id: string; company_id: string; can_sales: boolean; can_admin: boolean; access: Access[] };

const ctx = (user: string) => asUser(db, user, async (tx) => (await one<{ r: Context }>(tx, "select public.my_context() as r")).r);
const appRole = (user: string) => asUser(db, user, async (tx) => (await one<{ r: string }>(tx, "select private.app_role()::text as r")).r);
const switchTo = (user: string, company: string) => asUser(db, user, (tx) => tx.query("select public.set_active_company($1)", [company]));
const give = (user: string, access: Access[], actor = owner) =>
  asUser(db, actor, (tx) => tx.query("select public.set_user_company_access($1, $2::jsonb)", [user, JSON.stringify(access)]));
const team = () => asUser(db, owner, async (tx) => (await one<{ r: TeamUser[] }>(tx, "select public.super_list_team_access() as r")).r);
const leadNames = (user: string) => asUser(db, user, async (tx) =>
  (await one<{ r: { items: { name: string }[] } }>(tx, "select public.list_leads(p_limit => 100) as r")).r.items.map((l) => l.name).sort());
const companiesSeen = (user: string) => asUser(db, user, async (tx) => (await rows<{ id: string }>(tx, "select id from public.companies")).map((r) => r.id));
const staffIds = (user: string) => asUser(db, user, async (tx) => (await rows<{ id: string }>(tx, "select id from public.list_lead_staff()")).map((r) => r.id));

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  farm = await createCompany(db, "Star Managed Farmlands");
  coorg = await createCompany(db, "Land in Coorg");
  owner = await createUser(db, "owner", "super_admin");
  adminHub = await createUser(db, "admin_hub", "admin", "Admin Hub");
  adminSales = await createUser(db, "admin_sales", "admin", "Admin Sales");
  await db.query("update public.profiles set extra_roles = '{sales}' where id = $1", [adminSales]);
  salesA = await createUser(db, "sales_a", "sales", "Sales A");
  adminFarm = await createUser(db, "admin_farm", "admin", "Admin Farm", farm);
  salesFarm = await createUser(db, "sales_farm", "sales", "Sales Farm", farm);
  accountFarm = await createUser(db, "account_farm", "account", "Account Farm", farm);
  ws = await asUser(db, adminHub, async (tx) => {
    const client = (await one<{ id: string }>(tx, "select public.create_ads_client('Ashok') as id")).id;
    return (await one<{ id: string }>(tx, "select public.open_ads_client_crm($1) as id", [client])).id;
  });
  await createLead(db, adminHub, { name: "Hub lead" });
  await createLead(db, adminFarm, { name: "Farm lead 1", ownerId: salesFarm });
  await createLead(db, adminFarm, { name: "Farm lead 2", ownerId: adminFarm });
});

describe("giving companies", () => {
  it("only the super admin can, only roles the person has at home, only other companies of ours", async () => {
    await expect(give(adminHub, [{ company_id: farm, role: "admin" }], adminHub)).rejects.toThrow(/forbidden/);
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.super_list_team_access()"))).rejects.toThrow(/forbidden/);
    await expect(give(salesA, [{ company_id: farm, role: "admin" }])).rejects.toThrow(/invalid_access/);
    await expect(give(adminHub, [{ company_id: farm, role: "sales" }])).rejects.toThrow(/invalid_access/);
    await expect(give(adminHub, [{ company_id: hub, role: "admin" }])).rejects.toThrow(/not_found/);
    await expect(give(adminHub, [{ company_id: ws, role: "admin" }])).rejects.toThrow(/not_found/);
    await expect(give(adminHub, [{ company_id: farm, role: "admin" }, { company_id: farm, role: "admin" }])).rejects.toThrow(/invalid_access/);
    await expect(give(accountFarm, [{ company_id: hub, role: "admin" }])).rejects.toThrow(/not_found/);

    await give(adminHub, [{ company_id: farm, role: "admin" }]);
    await give(adminSales, [{ company_id: farm, role: "admin" }, { company_id: coorg, role: "sales" }]);
    const list = await team();
    expect(list.find((u) => u.id === adminHub)).toMatchObject({ company_id: hub, can_admin: true, can_sales: false, access: [{ company_id: farm, role: "admin" }] });
    expect(list.find((u) => u.id === adminSales)?.access).toEqual([{ company_id: farm, role: "admin" }, { company_id: coorg, role: "sales" }]);
    expect(list.find((u) => u.id === salesA)).toMatchObject({ can_admin: false, can_sales: true, access: [] });
    expect(list.some((u) => u.id === accountFarm || u.id === owner)).toBe(false);
  });
});

describe("working in another company as Admin", () => {
  it("switches there and is Admin, with every lead of that company", async () => {
    expect((await companiesSeen(adminHub)).sort()).toEqual([hub, farm, ws].sort());
    await expect(switchTo(adminHub, coorg)).rejects.toThrow(/forbidden/);
    await switchTo(adminHub, farm);
    expect(await ctx(adminHub)).toMatchObject({ company_id: farm, roles: ["admin"], visiting: true, visiting_role: "admin" });
    expect(await appRole(adminHub)).toBe("admin");
    expect(await leadNames(adminHub)).toEqual(["Farm lead 1", "Farm lead 2"]);
  });

  it("reassigns leads, manages that company's users and sees its finance", async () => {
    const lead = (await one<{ id: string }>(db, "select id from public.leads where name = 'Farm lead 1'")).id;
    await asUser(db, adminHub, (tx) => tx.query("update public.leads set owner_id = $2 where id = $1", [lead, adminFarm]));
    expect((await one<{ owner_id: string }>(db, "select owner_id from public.leads where id = $1", [lead])).owner_id).toBe(adminFarm);

    await asUser(db, adminHub, (tx) => tx.query("select public.admin_update_user($1, p_display_name => 'Sales Farm 2')", [salesFarm]));
    expect((await one<{ display_name: string }>(db, "select display_name from public.profiles where id = $1", [salesFarm])).display_name).toBe("Sales Farm 2");
    // Not users of their home company while they work here.
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.admin_update_user($1, p_display_name => 'x')", [salesA]))).rejects.toThrow(/not_found/);
    // The farm's own last admin is still protected: the visitor doesn't count.
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.admin_update_user($1, p_is_active => false)", [adminFarm]))).rejects.toThrow(/last_admin/);

    // Records an expense there: it goes into the farm's books.
    await asUser(db, adminHub, (tx) => tx.query(
      "insert into public.expenses (expense_date, category, amount, description, created_by) values (private.ist_today(), 'rent', 500, 'Farm rent', $1)", [adminHub]));
    expect((await one<{ company_id: string }>(db, "select company_id from public.expenses where description = 'Farm rent'")).company_id).toBe(farm);
    const seen = await asUser(db, adminHub, async (tx) => rows<{ company_id: string }>(tx, "select company_id from public.expenses where archived_at is null"));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.company_id === farm)).toBe(true);
  });

  it("is a pickable owner and visible there; back home they are their home self", async () => {
    expect(await staffIds(adminFarm)).toContain(adminHub);
    const visible = await asUser(db, adminFarm, async (tx) => (await rows<{ id: string }>(tx, "select id from public.profiles")).map((r) => r.id));
    expect(visible).toContain(adminHub);
    await switchTo(adminHub, hub);
    expect(await ctx(adminHub)).toMatchObject({ company_id: hub, visiting: false, visiting_role: null });
    expect(await leadNames(adminHub)).toEqual(["Hub lead"]);
  });

  it("gets that company's admin alerts, with the company name", async () => {
    await db.query("select private.enqueue_for_company($1, '{admin}', 'payment_received', '{\"amount\": 100}'::jsonb, 'test:pay:1')", [farm]);
    const got = await rows<{ recipient_id: string; payload: { company?: string } }>(db,
      "select recipient_id, payload from public.app_notifications where dedupe_key = 'test:pay:1'");
    const byUser = new Map(got.map((g) => [g.recipient_id, g.payload]));
    expect(byUser.get(adminHub)).toMatchObject({ amount: 100, company: "Star Managed Farmlands" });
    expect(byUser.get(adminFarm)).toEqual({ amount: 100 });
    expect(byUser.has(salesA)).toBe(false);
    // Sales-only visitors don't get admin alerts.
    await db.query("select private.enqueue_for_company($1, '{admin}', 'payment_received', '{}'::jsonb, 'test:pay:2')", [coorg]);
    expect(await rows(db, "select 1 from public.app_notifications where dedupe_key = 'test:pay:2' and recipient_id = $1", [adminSales])).toHaveLength(0);
  });
});

describe("mixed access", () => {
  it("an admin given a company as Sales is Sales only there", async () => {
    await switchTo(adminSales, coorg);
    expect(await ctx(adminSales)).toMatchObject({ company_id: coorg, roles: ["sales"], visiting_role: "sales" });
    expect(await appRole(adminSales)).toBe("sales");
    await switchTo(adminSales, farm);
    expect(await ctx(adminSales)).toMatchObject({ company_id: farm, roles: ["admin"], visiting_role: "admin" });
    await switchTo(adminSales, hub);
  });

  it("the earlier Sales team save (set_sales_user_companies) leaves admin rows alone", async () => {
    await asUser(db, owner, (tx) => tx.query("select public.set_sales_user_companies($1, '{}'::uuid[])", [adminSales]));
    expect((await team()).find((u) => u.id === adminSales)?.access).toEqual([{ company_id: farm, role: "admin" }]);
  });
});

describe("access ends at once", () => {
  it("when the company is taken away", async () => {
    await switchTo(adminHub, farm);
    await give(adminHub, []);
    expect((await ctx(adminHub)).company_id).toBe(hub);
    await expect(switchTo(adminHub, farm)).rejects.toThrow(/forbidden/);
    expect(await staffIds(adminFarm)).not.toContain(adminHub);
  });

  it("when they lose the admin role at home, are deactivated, or the company is archived", async () => {
    await give(adminHub, [{ company_id: farm, role: "admin" }]);
    await switchTo(adminHub, farm);

    await db.query("update public.profiles set role = 'account' where id = $1", [adminHub]);
    expect((await ctx(adminHub)).company_id).toBe(hub);
    await db.query("update public.profiles set role = 'admin' where id = $1", [adminHub]);
    expect((await ctx(adminHub)).company_id).toBe(farm);

    await db.query("update public.profiles set is_active = false where id = $1", [adminHub]);
    expect(await asUser(db, adminHub, async (tx) => (await one<{ r: unknown }>(tx, "select public.my_context() as r")).r)).toBeNull();
    await db.query("update public.profiles set is_active = true where id = $1", [adminHub]);

    await db.query("update public.companies set archived_at = now() where id = $1", [farm]);
    expect((await ctx(adminHub)).company_id).toBe(hub);
    expect(await companiesSeen(adminHub)).not.toContain(farm);
  });
});
