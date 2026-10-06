import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createUser, defaultCompany, one, rows, type Db } from "./harness";

let db: Db;
let hub: string, gardens: string, studio: string;
let owner: string, accHub: string, accGardens: string, adminStudio: string, salesHub: string;

const addExpense = (userId: string, category: string, amount: number, companyId?: string) =>
  asUser(db, userId, async (tx) => (await one<{ id: string }>(tx,
    `insert into public.expenses (expense_date, category, amount, created_by${companyId ? ", company_id" : ""})
     values (current_date, $1, $2, $3${companyId ? ", $4" : ""}) returning id`, companyId ? [category, amount, userId, companyId] : [category, amount, userId])).id);
const total = (userId: string) =>
  asUser(db, userId, async (tx) => Number((await one<{ s: string }>(tx, "select coalesce(sum(amount), 0) as s from public.expenses")).s));
const context = (userId: string) =>
  asUser(db, userId, async (tx) => (await one<{ r: { can_edit: boolean; companies: { id: string; name: string }[] } }>(tx, "select public.finance_context() as r")).r);
const merge = (ids: string[], editors: string[]) =>
  asUser(db, owner, (tx) => tx.query("select public.merge_finance($1::uuid[], $2::uuid[])", [ids, editors]));

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  gardens = await createCompany(db, "Star Gardens");
  studio = await createCompany(db, "Star Production House");
  owner = await createUser(db, "owner", "super_admin");
  accHub = await createUser(db, "acc_hub", "account");
  salesHub = await createUser(db, "sales_hub", "sales");
  accGardens = await createUser(db, "acc_gardens", "account", "Acc Gardens", gardens);
  adminStudio = await createUser(db, "admin_studio", "admin", "Admin Studio", studio);
  await addExpense(accHub, "Rent", 100);
  await addExpense(accGardens, "rent", 200);
  // A category only Star Gardens has.
  const seeds = await asUser(db, accGardens, async (tx) => (await one<{ id: string }>(tx, "select public.resolve_expense_category(p_new_name => 'Seeds') as id")).id);
  await asUser(db, accGardens, (tx) => tx.query("insert into public.expenses (expense_date, category_id, amount, created_by) values (current_date, $1, 50, $2)", [seeds, accGardens]));
});

describe("separate books", () => {
  it("each company sees only its own entries and categories", async () => {
    expect(await total(accHub)).toBe(100);
    expect(await total(accGardens)).toBe(250);
    const hubCats = await asUser(db, accHub, (tx) => rows<{ name: string }>(tx, "select name from public.expense_categories order by name"));
    expect(hubCats.map((c) => c.name)).not.toContain("Seeds");
    await expect(addExpense(accHub, "Seeds", 1)).rejects.toThrow(/category_not_found/);
    await expect(addExpense(accHub, "Rent", 1, gardens)).rejects.toThrow(/row-level security|forbidden/);
  });

  it("only the super admin merges", async () => {
    await expect(asUser(db, adminStudio, (tx) => tx.query("select public.merge_finance($1::uuid[], $2::uuid[])", [[studio, hub], [studio]])))
      .rejects.toThrow(/forbidden/);
  });
});

describe("merged books", () => {
  it("everyone with finance access sees all entries; categories join by name", async () => {
    await merge([hub, gardens, studio], [hub]);
    expect(await total(accHub)).toBe(350);
    expect(await total(accGardens)).toBe(350);
    expect(await total(adminStudio)).toBe(350);
    const cats = await asUser(db, accGardens, (tx) => rows<{ name: string }>(tx, "select name from public.expense_categories order by name"));
    expect(cats.map((c) => c.name)).toEqual(["Marketing", "Miscellaneous", "Rent", "Salary", "Seeds", "Software", "Utilities"]);
    const rent = await rows<{ category_id: string }>(db, "select distinct category_id from public.expenses where category = 'Rent'");
    expect(rent).toHaveLength(1);
    await expect(asUser(db, salesHub, (tx) => rows(tx, "select id from public.expenses"))).resolves.toEqual([]);
  });

  it("only editor companies add or change entries, for any company of the books", async () => {
    expect((await context(accHub)).can_edit).toBe(true);
    expect((await context(accGardens)).can_edit).toBe(false);
    expect((await context(accGardens)).companies.map((c) => c.id).sort()).toEqual([hub, gardens, studio].sort());

    const forStudio = await addExpense(accHub, "Seeds", 10, studio);
    expect((await one<{ company_id: string }>(db, "select company_id from public.expenses where id = $1", [forStudio])).company_id).toBe(studio);
    await expect(addExpense(accGardens, "Rent", 5)).rejects.toThrow(/row-level security/);
    const updated = await asUser(db, accGardens, (tx) => tx.query("update public.expenses set amount = 1 where id = $1", [forStudio]));
    expect(updated.affectedRows).toBe(0);
    await expect(asUser(db, accGardens, (tx) => tx.query("select public.resolve_expense_category(p_new_name => 'Fuel')"))).rejects.toThrow(/forbidden/);

    // Moving an entry to another company of the same books is recorded in its history.
    await asUser(db, accHub, (tx) => tx.query("update public.expenses set company_id = $2 where id = $1", [forStudio, gardens]));
    const hist = await one<{ changes: Record<string, unknown> }>(db,
      "select changes from public.finance_activities where entity_id = $1 and action = 'updated'", [forStudio]);
    expect(hist.changes).toEqual({ company: { from: "Star Production House", to: "Star Gardens" } });

    await asUser(db, owner, (tx) => tx.query("select public.set_finance_editors($1::uuid[])", [[gardens]]));
    expect((await context(accGardens)).can_edit).toBe(true);
    expect((await context(accHub)).can_edit).toBe(false);
  });

  it("splitting a company out takes its entries back and keeps the categories it needs", async () => {
    await asUser(db, owner, (tx) => tx.query("select public.split_finance($1)", [gardens]));
    expect(await total(accGardens)).toBe(260); // 200 + 50 seeds + 10 moved to Gardens
    expect(await total(accHub)).toBe(100);
    expect(await total(adminStudio)).toBe(100);
    expect((await context(accGardens)).can_edit).toBe(true);
    const gardensCats = await asUser(db, accGardens, (tx) => rows<{ name: string }>(tx, "select name from public.expense_categories where archived_at is null order by name"));
    expect(gardensCats.map((c) => c.name)).toContain("Seeds");
    // Hub and Studio stay merged. Gardens was the only editor, so both remaining companies may edit again.
    expect((await context(accHub)).companies).toHaveLength(2);
    expect((await context(accHub)).can_edit).toBe(true);
    await expect(asUser(db, owner, (tx) => tx.query("select public.split_finance($1)", [gardens]))).rejects.toThrow(/not_merged/);
  });

  it("a renamed category renames its entries", async () => {
    const seeds = (await asUser(db, accGardens, async (tx) => one<{ id: string }>(tx, "select id from public.expense_categories where name = 'Seeds'"))).id;
    await asUser(db, accGardens, (tx) => tx.query("select public.update_expense_category($1, 'Seeds & saplings')", [seeds]));
    const names = await asUser(db, accGardens, (tx) => rows<{ category: string }>(tx, "select distinct category from public.expenses where category_id = $1", [seeds]));
    expect(names).toEqual([{ category: "Seeds & saplings" }]);
  });
});
