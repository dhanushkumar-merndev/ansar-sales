import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createUser, defaultCompany, one, rows, type Db } from "./harness";

let db: Db;
let hub: string, farm: string;
let owner: string, adminHub: string, adminFarm: string, salesFarm: string, salesHub: string, retired: string;

const staff = (user: string) => asUser(db, user, async (tx) =>
  (await rows<{ id: string }>(tx, "select id from public.list_lead_staff()")).map((r) => r.id).sort());
const users = (user: string, includeInactive?: boolean) => asUser(db, user, async (tx) =>
  (await one<{ r: { items: { id: string }[]; total: number } }>(tx,
    "select public.admin_list_users(p_limit => 100, p_include_inactive => $1) as r", [includeInactive ?? null])).r);

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  farm = await createCompany(db, "Star Managed Farmlands");
  // One set of books for both companies: admins can see each other's staff for finance.
  const group = (await one<{ id: string }>(db, "insert into public.finance_groups default values returning id")).id;
  await db.query("update public.companies set finance_group_id = $1 where id = any($2::uuid[])", [group, [hub, farm]]);
  owner = await createUser(db, "owner", "super_admin");
  adminHub = await createUser(db, "admin_hub", "admin", "Admin Hub");
  salesHub = await createUser(db, "sales_hub", "sales", "Sales Hub");
  adminFarm = await createUser(db, "admin_farm", "admin", "Admin Farm", farm);
  salesFarm = await createUser(db, "sales_farm", "sales", "Sales Farm", farm);
  retired = await createUser(db, "retired_farm", "sales", "Retired Farm", farm);
  await db.query("update public.profiles set is_active = false where id = $1", [retired]);
  await asUser(db, owner, (tx) => tx.query("select public.set_sales_user_companies($1, $2::uuid[])", [salesHub, [farm]]));
});

describe("lead owner pickers", () => {
  it("list only people who can own a lead in the current company", async () => {
    // The hub admin is visible through the shared books, but can't own a Farmlands lead.
    expect(await asUser(db, adminFarm, async (tx) => (await rows(tx, "select 1 from public.profiles where id = $1", [adminHub])).length)).toBe(1);
    expect(await staff(adminFarm)).toEqual([adminFarm, salesFarm, salesHub].sort());
    expect(await staff(salesFarm)).toEqual([adminFarm, salesFarm, salesHub].sort());
    expect(await staff(adminHub)).toEqual([adminHub, salesHub].sort());
  });
});

describe("users list", () => {
  it("hides deactivated people unless asked", async () => {
    const active = await users(adminFarm);
    expect(active.items.map((u) => u.id).sort()).toEqual([adminFarm, salesFarm].sort());
    expect(active.total).toBe(2);
    const all = await users(adminFarm, true);
    expect(all.items.map((u) => u.id)).toContain(retired);
    expect(all.total).toBe(3);
  });
});
