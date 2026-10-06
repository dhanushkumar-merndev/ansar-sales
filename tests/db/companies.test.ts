import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createLead, createUser, defaultCompany, one, rows, type Db } from "./harness";

let db: Db;
let companyA: string, companyB: string;
let owner: string, adminA: string, salesA: string, accountA: string, adminB: string, salesB: string, accountB: string;

const leadIds = (userId: string) => asUser(db, userId, (tx) => rows<{ id: string }>(tx, "select id from public.leads")).then((r) => r.map((x) => x.id));
const switchTo = (companyId: string) => asUser(db, owner, (tx) => tx.query("select public.set_active_company($1)", [companyId]));

beforeAll(async () => {
  db = await createDb();
  companyA = await defaultCompany(db);
  companyB = await createCompany(db, "Star Gardens");
  owner = await createUser(db, "owner", "super_admin", "Owner");
  adminA = await createUser(db, "admin_a", "admin", "Admin A");
  salesA = await createUser(db, "sales_a", "sales", "Sales A");
  accountA = await createUser(db, "account_a", "account", "Account A");
  adminB = await createUser(db, "admin_b", "admin", "Admin B", companyB);
  salesB = await createUser(db, "sales_b", "sales", "Sales B", companyB);
  accountB = await createUser(db, "account_b", "account", "Account B", companyB);
});

describe("company isolation", () => {
  it("keeps leads, niches and duplicate checks inside the company", async () => {
    const phone = "+919812345670";
    const leadA = await createLead(db, salesA, { phone, niche: "Retail" });
    const leadB = await createLead(db, salesB, { phone, niche: "Retail" }); // same phone is no duplicate across companies

    expect(await leadIds(adminA)).toContain(leadA);
    expect(await leadIds(adminA)).not.toContain(leadB);
    expect(await leadIds(adminB)).toEqual([leadB]);

    const niches = await rows<{ company_id: string }>(db, "select company_id from public.niches where normalized_name = 'retail' order by company_id");
    expect(niches.map((n) => n.company_id).sort()).toEqual([companyA, companyB].sort());
    expect(await asUser(db, salesB, async (tx) => (await one<{ r: { duplicate: boolean } }>(tx, "select public.check_duplicate_phone($1) as r", [phone])).r))
      .toMatchObject({ duplicate: true });
    const otherPhone = "+919812345671";
    await createLead(db, salesA, { phone: otherPhone });
    expect(await asUser(db, salesB, async (tx) => (await one<{ r: { duplicate: boolean } }>(tx, "select public.check_duplicate_phone($1) as r", [otherPhone])).r))
      .toEqual({ duplicate: false });

    // Direct writes to another company's lead change nothing (RLS) or are refused (guard).
    const res = await asUser(db, adminB, (tx) => tx.query("update public.leads set name = 'x' where id = $1", [leadA]));
    expect(res.affectedRows).toBe(0);
    await expect(asUser(db, adminB, (tx) => tx.query("select public.log_call($1)", [leadA]))).rejects.toThrow();
  });

  it("refuses an owner or niche from another company", async () => {
    const leadB = await createLead(db, salesB);
    await expect(asUser(db, adminB, (tx) => tx.query("update public.leads set owner_id = $2 where id = $1", [leadB, salesA])))
      .rejects.toThrow(/invalid_owner/);
    const nicheA = (await one<{ id: string }>(db, "select id from public.niches where company_id = $1 limit 1", [companyA])).id;
    await expect(asUser(db, adminB, (tx) => tx.query("update public.leads set niche_id = $2 where id = $1", [leadB, nicheA])))
      .rejects.toThrow(/niche_not_found/);
    // A super admin may own leads in any company.
    await switchTo(companyB);
    await asUser(db, adminB, (tx) => tx.query("update public.leads set owner_id = $2 where id = $1", [leadB, owner]));
    expect(await leadIds(owner)).toContain(leadB);
  });

  it("keeps the library and sharing inside the company", async () => {
    const folderA = await asUser(db, adminA, async (tx) => (await one<{ id: string }>(tx, "insert into public.library_folders (name) values ('Docs') returning id")).id);
    await asUser(db, adminB, (tx) => tx.query("insert into public.library_folders (name) values ('Docs')")); // same name, other company
    expect(await asUser(db, adminB, (tx) => rows(tx, "select id from public.library_folders where id = $1", [folderA]))).toHaveLength(0);

    const path = `${folderA}/${randomUUID()}.pdf`;
    await asUser(db, salesA, (tx) => tx.query("insert into storage.objects (bucket_id, name, metadata) values ('library', $1, $2)", [path, { size: 10, mimetype: "application/pdf" }]));
    const fileA = await asUser(db, salesA, async (tx) =>
      (await one<{ id: string }>(tx, "insert into public.library_files (folder_id, name, storage_path) values ($1, 'A.pdf', $2) returning id", [folderA, path])).id);
    expect(await asUser(db, salesB, (tx) => rows(tx, "select name from storage.objects where name = $1", [path]))).toHaveLength(0);
    await expect(asUser(db, salesB, (tx) =>
      tx.query("insert into public.library_files (folder_id, name, storage_path) values ($1, 'B.pdf', $2)", [folderA, `${folderA}/${randomUUID()}.pdf`]))).rejects.toThrow();

    const leadB = await createLead(db, salesB);
    await expect(asUser(db, salesB, (tx) => tx.query("select public.share_lead_files($1, $2::uuid[], '7d')", [leadB, [fileA]])))
      .rejects.toThrow(/share_file_unavailable/);
    await expect(asUser(db, salesB, (tx) => tx.query("select public.set_library_thumbnail($1, $2)", [fileA, `${folderA}/thumbs/${randomUUID()}.webp`])))
      .rejects.toThrow();
  });

  it("keeps finance inside the company", async () => {
    await asUser(db, accountA, (tx) => tx.query("insert into public.expenses (expense_date, category, amount, created_by) values (current_date, 'rent', 100, $1)", [accountA]));
    await asUser(db, accountB, (tx) => tx.query("insert into public.expenses (expense_date, category, amount, created_by) values (current_date, 'rent', 200, $1)", [accountB]));
    const sum = (userId: string) => asUser(db, userId, async (tx) => Number((await one<{ s: string }>(tx, "select coalesce(sum(amount), 0) as s from public.expenses")).s));
    expect(await sum(accountA)).toBe(100);
    expect(await sum(accountB)).toBe(200);
    const expenseA = (await one<{ id: string }>(db, "select id from public.expenses where company_id = $1 limit 1", [companyA])).id;
    await expect(asUser(db, accountB, (tx) => tx.query("select public.set_expense_recurrence($1, true)", [expenseA]))).rejects.toThrow();
  });
});

describe("users", () => {
  it("lists and manages only the company's own users", async () => {
    const visible = await asUser(db, adminB, (tx) => rows<{ username: string }>(tx, "select username from public.profiles order by username"));
    expect(visible.map((p) => p.username)).toEqual(["account_b", "admin_b", "owner", "sales_b"]);
    const listed = await asUser(db, adminB, async (tx) => (await one<{ r: { items: { username: string }[] } }>(tx, "select public.admin_list_users() as r")).r);
    expect(listed.items.map((u) => u.username).sort()).toEqual(["account_b", "admin_b", "sales_b"]);

    await expect(asUser(db, adminB, (tx) => tx.query("select public.admin_update_user($1, p_display_name => 'x')", [salesA]))).rejects.toThrow(/not_found/);
    await expect(asUser(db, adminB, (tx) => tx.query("select public.admin_update_user($1, p_role => 'super_admin')", [salesB]))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, adminB, (tx) => tx.query("select public.admin_log_password_reset($1)", [salesA]))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, adminB, (tx) => tx.query("select public.admin_update_user($1, p_is_active => false)", [adminB]))).rejects.toThrow(/last_admin/);
  });

  it("requires a company for every user but the super admin", async () => {
    await expect(db.query(`insert into auth.users (email, raw_app_meta_data) values ('x@login.test', '{"crm_role":"sales","crm_username":"nocompany","crm_display_name":"X"}')`))
      .rejects.toThrow(/company_required/);
    await expect(db.query("update public.profiles set company_id = null where id = $1", [salesA])).rejects.toThrow(/profiles_company_check/);
  });
});

describe("super admin", () => {
  it("works as admin of the active company and can switch", async () => {
    await switchTo(companyA);
    const inA = await leadIds(owner);
    expect(inA.sort()).toEqual((await leadIds(adminA)).sort());
    await switchTo(companyB);
    expect((await leadIds(owner)).sort()).toEqual((await leadIds(adminB)).sort());
    expect(await asUser(db, owner, (tx) => rows(tx, "select id from public.companies"))).toHaveLength(2);
    expect(await asUser(db, adminB, (tx) => rows<{ id: string }>(tx, "select id from public.companies"))).toEqual([{ id: companyB }]);
  });

  it("is the only one who can create companies or switch", async () => {
    await expect(asUser(db, adminA, (tx) => tx.query("select public.create_company('Mine')"))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, adminA, (tx) => tx.query("select public.set_active_company($1)", [companyB]))).rejects.toThrow(/forbidden/);
    const id = await asUser(db, owner, async (tx) => (await one<{ id: string }>(tx, "select public.create_company('Star Production House', 'Production') as id")).id);
    await expect(asUser(db, owner, (tx) => tx.query("select public.create_company('star production  house')"))).rejects.toThrow(/company_name_taken/);
    await switchTo(id);
    expect(await leadIds(owner)).toEqual([]);
    const lead = await createLead(db, adminA);
    expect(await asUser(db, owner, async (tx) => (await one<{ c: string }>(tx, "select public.super_lead_company($1) as c", [lead])).c)).toBe(companyA);
    expect(await asUser(db, adminA, async (tx) => (await one<{ c: string | null }>(tx, "select public.super_lead_company($1) as c", [lead])).c)).toBeNull();
  });

  it("users of an archived company lose access", async () => {
    const c = await createCompany(db, "Closed Co");
    const u = await createUser(db, "closed_admin", "admin", "Closed", c);
    await createLead(db, u);
    await db.query("update public.companies set archived_at = now() where id = $1", [c]);
    expect(await leadIds(u)).toEqual([]);
    expect(await asUser(db, u, async (tx) => (await one<{ r: string | null }>(tx, "select private.app_role() as r")).r)).toBeNull();
  });
});

describe("notifications", () => {
  it("send company events to that company's admins and the super admin only", async () => {
    let chat = 500;
    for (const id of [owner, adminA, adminB]) {
      chat += 1;
      await asService(db, (tx) => tx.query("insert into public.telegram_connections (user_id, chat_id) values ($1, $2)", [id, chat]));
    }
    const lead = await createLead(db, salesA);
    const queued = await rows<{ recipient_id: string; company: string | null }>(db,
      "select recipient_id, payload ->> 'company' as company from public.telegram_notifications where kind = 'lead_created' and lead_id = $1", [lead]);
    expect(queued.map((q) => q.recipient_id).sort()).toEqual([owner, adminA].sort());
    expect(queued.find((q) => q.recipient_id === owner)?.company).toBe("Star Growth Hub");
    expect(queued.find((q) => q.recipient_id === adminA)?.company).toBeNull();
  });
});
