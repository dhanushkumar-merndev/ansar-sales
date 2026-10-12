import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createLead, createUser, one, rows, type Db } from "./harness";

let db: Db;
let gardens: string;
let admin: string, sales: string, account: string, other: string, gardensAdmin: string;

const update = (actor: string, target: string, args: { role?: string; extra?: string[]; active?: boolean }) =>
  asUser(db, actor, (tx) =>
    tx.query("select public.admin_update_user(p_user_id => $1, p_role => $2::public.app_role, p_is_active => $3, p_extra_roles => $4::public.app_role[])", [
      target, args.role ?? null, args.active ?? null, args.extra ? `{${args.extra.join(",")}}` : null,
    ]),
  );
const financeRows = (uid: string) => asUser(db, uid, (tx) => rows(tx, "select id from public.expenses"));

beforeAll(async () => {
  db = await createDb();
  gardens = await createCompany(db, "Star Gardens");
  await db.query("update public.companies set features = array['projects'] where id = $1", [gardens]);
  admin = await createUser(db, "admin", "admin");
  sales = await createUser(db, "sales", "sales");
  account = await createUser(db, "account", "account");
  other = await createUser(db, "other", "sales");
  gardensAdmin = await createUser(db, "g_admin", "admin", "G Admin", gardens);
  await asUser(db, account, (tx) =>
    tx.query("insert into public.expenses (expense_date, category, amount, created_by) values (private.ist_today(), 'rent', 100, $1)", [account]));
});

describe("extra roles", () => {
  it("gives a person the permissions of every role they have, and takes them away again", async () => {
    await expect(financeRows(sales)).resolves.toHaveLength(0);
    await update(admin, sales, { extra: ["account"] });
    await expect(financeRows(sales)).resolves.toHaveLength(1);
    // Still a salesperson: creates leads and sees only their own.
    const lead = await createLead(db, sales);
    const otherLead = await createLead(db, other);
    const visible = await asUser(db, sales, (tx) => rows<{ id: string }>(tx, "select id from public.leads"));
    expect(visible.map((l) => l.id)).toContain(lead);
    expect(visible.map((l) => l.id)).not.toContain(otherLead);

    await update(admin, sales, { extra: [] });
    await expect(financeRows(sales)).resolves.toHaveLength(0);
  });

  it("lets an account person also work leads (sales scope)", async () => {
    await update(admin, account, { extra: ["sales"] });
    const lead = await createLead(db, account);
    const visible = await asUser(db, account, (tx) => rows<{ id: string }>(tx, "select id from public.leads"));
    expect(visible.map((l) => l.id)).toEqual([lead]);
    await expect(financeRows(account)).resolves.toHaveLength(1);
    // Dropping sales while owning leads is refused.
    await expect(update(admin, account, { extra: [] })).rejects.toThrow(/reassign_leads_first/);
  });

  it("drops the main role from extras and refuses portal/ads/super roles", async () => {
    await update(admin, other, { extra: ["sales", "account"] });
    expect((await one<{ extra_roles: string[] }>(db, "select extra_roles::text[] as extra_roles from public.profiles where id = $1", [other])).extra_roles).toEqual(["account"]);
    await expect(update(admin, other, { extra: ["client"] })).rejects.toThrow(/forbidden/);
    await expect(update(admin, other, { extra: ["super_admin"] })).rejects.toThrow(/forbidden/);
  });

  it("counts an admin extra role for the last-admin rule", async () => {
    const solo = await createUser(db, "g_sales", "sales", "G Sales", gardens);
    await update(gardensAdmin, solo, { extra: ["admin"] });
    // Two admins now, so the original may step down.
    await update(solo, gardensAdmin, { role: "sales" });
    // The remaining admin (by extra role) is the last one.
    await expect(update(solo, solo, { extra: [] })).rejects.toThrow(/last_admin/);
  });

  it("allows project roles only where the projects module is on", async () => {
    await expect(update(admin, other, { extra: ["architect_manager"] })).rejects.toThrow(/feature_disabled/);
    const gardensBoss = (await one<{ id: string }>(db, "select id from public.profiles where username = 'g_sales'")).id;
    const designer = await createUser(db, "g_designer", "sales", "G Designer", gardens);
    await update(gardensBoss, designer, { role: "landscape_designer", extra: ["execution"] });
    const p = await one<{ role: string; extra_roles: string[] }>(db, "select role::text as role, extra_roles::text[] as extra_roles from public.profiles where id = $1", [designer]);
    expect(p).toEqual({ role: "landscape_designer", extra_roles: ["execution"] });
    const roles = await asUser(db, designer, async (tx) => (await one<{ r: string[] }>(tx, "select private.my_roles()::text[] as r")).r);
    expect(roles).toEqual(["landscape_designer", "execution"]);
  });

  it("notifies people for the kinds of all their roles", async () => {
    const kinds = await one<{ k: string[] }>(db, "select private.notification_kinds_for_roles('sales', array['account']::public.app_role[]) as k");
    expect(kinds.k).toEqual(expect.arrayContaining(["lead_assigned", "expense_added", "digest_finance"]));
  });
});

describe("company features", () => {
  it("only the super admin switches modules, and Star Gardens stages follow its sales process", async () => {
    const owner = await createUser(db, "owner", "super_admin");
    const fresh = await createCompany(db, "Fresh Co");
    await expect(asUser(db, admin, (tx) => tx.query("select public.set_company_feature($1, 'projects', true)", [fresh]))).rejects.toThrow(/forbidden/);
    await asUser(db, owner, (tx) => tx.query("select public.set_company_feature($1, 'projects', true)", [fresh]));
    const stages = await rows<{ name: string }>(db, "select name from public.pipeline_stages where company_id = $1 order by position", [fresh]);
    expect(stages.map((s) => s.name)).toEqual(["Inquiry", "Pitch", "Negotiation", "On hold", "Closed", "Lost"]);
    await expect(asUser(db, owner, (tx) => tx.query("select public.set_company_feature($1, 'nope', true)", [fresh]))).rejects.toThrow(/invalid_feature/);
  });
});
