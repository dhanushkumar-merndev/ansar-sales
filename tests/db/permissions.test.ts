import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createLead, createUser, nextPhone, one, rows, type Db } from "./harness";

let db: Db;
let admin: string, salesA: string, salesB: string, account: string;

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
  account = await createUser(db, "account", "account", "Accounts");
});

const count = (userId: string | null, table: string) =>
  asUser(db, userId, async (tx) => (await one<{ n: number }>(tx, `select count(*)::int as n from public.${table}`)).n);

describe("user provisioning", () => {
  it("creates profiles from trusted app_metadata in the same transaction", async () => {
    const p = await one<{ role: string; username: string }>(db, "select role, username from public.profiles where id = $1", [salesA]);
    expect(p).toEqual({ role: "sales", username: "sales.a" });
  });

  it("ignores later app_metadata changes for an existing profile", async () => {
    await db.query(`update auth.users set raw_app_meta_data = raw_app_meta_data || '{"crm_role":"admin"}' where id = $1`, [salesA]);
    const p = await one<{ role: string }>(db, "select role from public.profiles where id = $1", [salesA]);
    expect(p.role).toBe("sales");
  });

  it("rejects a duplicate username and rolls back the Auth user", async () => {
    await expect(createUser(db, "sales.a", "sales")).rejects.toThrow();
    expect((await one<{ n: number }>(db, "select count(*)::int as n from auth.users where email like 'sales.a@%'")).n).toBe(1);
  });

  it("rejects invalid usernames", async () => {
    await expect(createUser(db, "Bad Name", "sales")).rejects.toThrow();
  });

  it("does not let non-admins manage users or escalate their own role", async () => {
    await expect(asUser(db, salesA, (tx) => tx.query("select public.admin_update_user($1, null, 'admin', null)", [salesA]))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, salesA, (tx) => tx.query("update public.profiles set role = 'admin' where id = $1", [salesA]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, salesA, (tx) => tx.query("insert into public.profiles (id, username, display_name, role) values (gen_random_uuid(), 'x1y', 'x', 'admin')"))).rejects.toThrow(/permission denied/);
  });

  it("always keeps at least one active admin", async () => {
    await expect(asUser(db, admin, (tx) => tx.query("select public.admin_update_user($1, null, null, false)", [admin]))).rejects.toThrow(/last_admin/);
    await expect(asUser(db, admin, (tx) => tx.query("select public.admin_update_user($1, null, 'sales', null)", [admin]))).rejects.toThrow(/last_admin/);
  });

  it("anon has no table access", async () => {
    await expect(count(null, "leads")).rejects.toThrow(/permission denied/);
    await expect(count(null, "profiles")).rejects.toThrow(/permission denied/);
  });
});

describe("lead scope", () => {
  let leadA: string;

  beforeAll(async () => {
    leadA = await createLead(db, salesA, { name: "Alpha Traders", note: "Met at expo", followUpAt: "2099-01-01T05:00:00Z" });
  });

  it("sales sees only own leads; admin sees all; account sees none", async () => {
    expect(await count(salesA, "leads")).toBe(1);
    expect(await count(salesB, "leads")).toBe(0);
    expect(await count(account, "leads")).toBe(0);
    expect(await count(admin, "leads")).toBe(1);
    expect(await count(account, "lead_activities")).toBe(0);
    expect(await count(account, "follow_ups")).toBe(0);
    expect(await count(salesB, "lead_activities")).toBe(0);
  });

  it("account cannot create leads; sales cannot assign or archive", async () => {
    await expect(createLead(db, account)).rejects.toThrow(/forbidden/);
    await expect(asUser(db, salesA, (tx) => tx.query("update public.leads set owner_id = $1 where id = $2", [salesB, leadA]))).rejects.toThrow();
    await expect(asUser(db, salesA, (tx) => tx.query("update public.leads set archived_at = now() where id = $1", [leadA]))).rejects.toThrow();
  });

  it("sales cannot spoof a different owner when creating", async () => {
    const id = await createLead(db, salesA, { ownerId: salesB });
    const lead = await one<{ owner_id: string }>(db, "select owner_id from public.leads where id = $1", [id]);
    expect(lead.owner_id).toBe(salesA);
    await asUser(db, admin, (tx) => tx.query("update public.leads set archived_at = now() where id = $1", [id]));
  });

  it("other sales users cannot add notes or follow-ups to a lead they do not own", async () => {
    await expect(asUser(db, salesB, (tx) => tx.query("insert into public.lead_activities (lead_id, type, body, actor_id) values ($1, 'note', 'hi', $2)", [leadA, salesB]))).rejects.toThrow(/row-level security/);
    await expect(asUser(db, salesB, (tx) => tx.query("insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, 't', now(), $2)", [leadA, salesB]))).rejects.toThrow(/row-level security/);
    const updated = await asUser(db, salesB, (tx) => tx.query("update public.leads set status = 'won' where id = $1", [leadA]));
    expect(updated.affectedRows).toBe(0);
  });

  it("duplicate phone is flagged without disclosing another user's lead", async () => {
    const phone = (await one<{ phone: string }>(db, "select phone_normalized as phone from public.leads where id = $1", [leadA])).phone;
    const check = await asUser(db, salesB, async (tx) => (await one<{ r: { duplicate: boolean; visible_lead_id: string | null } }>(tx, "select public.check_duplicate_phone($1) as r", [phone])).r);
    expect(check).toEqual({ duplicate: true, visible_lead_id: null });
    await expect(createLead(db, salesB, { phone })).rejects.toThrow(/duplicate_phone/);
    const own = await asUser(db, salesA, async (tx) => (await one<{ r: { visible_lead_id: string } }>(tx, "select public.check_duplicate_phone($1) as r", [phone])).r);
    expect(own.visible_lead_id).toBe(leadA);
    // Intentional duplicate after confirmation.
    const dup = await asUser(db, salesB, async (tx) => (await one<{ id: string }>(tx,
      "select public.create_lead(p_name => 'Dup', p_phone => $1, p_phone_normalized => $1, p_new_niche => 'Retail', p_allow_duplicate => true) as id", [phone])).id);
    expect(dup).toBeTruthy();
  });

  it("reassignment moves access, pending follow-ups and reminder recipient", async () => {
    await asUser(db, admin, (tx) => tx.query("update public.leads set owner_id = $1 where id = $2", [salesB, leadA]));
    const aSees = await asUser(db, salesA, (tx) => rows(tx, "select id from public.leads where id = $1", [leadA]));
    const bSees = await asUser(db, salesB, (tx) => rows(tx, "select id from public.leads where id = $1", [leadA]));
    expect(aSees).toHaveLength(0);
    expect(bSees).toHaveLength(1);
    expect(await asUser(db, salesA, (tx) => rows(tx, "select id from public.lead_activities where lead_id = $1", [leadA]))).toHaveLength(0);

    const fu = await one<{ assignee_id: string; revision: number }>(db, "select assignee_id, revision from public.follow_ups where lead_id = $1", [leadA]);
    expect(fu).toEqual({ assignee_id: salesB, revision: 2 });
    const deliveries = await rows<{ revision: number; state: string; recipient_id: string }>(db,
      "select d.revision, d.state, d.recipient_id from public.reminder_deliveries d join public.follow_ups f on f.id = d.follow_up_id where f.lead_id = $1 order by d.revision", [leadA]);
    expect(deliveries).toEqual([
      { revision: 1, state: "cancelled", recipient_id: salesA },
      { revision: 2, state: "pending", recipient_id: salesB },
    ]);
    const assigned = await one<{ meta: { from: string; to: string } }>(db, "select meta from public.lead_activities where lead_id = $1 and type = 'assigned'", [leadA]);
    expect(assigned.meta).toEqual({ from: "Sales A", to: "Sales B" });
  });

  it("admin cannot assign a lead to an account user", async () => {
    await expect(asUser(db, admin, (tx) => tx.query("update public.leads set owner_id = $1 where id = $2", [account, leadA]))).rejects.toThrow(/invalid_owner/);
  });

  it("deactivation removes all data access immediately", async () => {
    await asUser(db, admin, (tx) => tx.query("select public.admin_update_user($1, null, null, false)", [salesB]));
    expect(await count(salesB, "leads")).toBe(0);
    expect(await count(salesB, "niches")).toBe(0);
    await expect(createLead(db, salesB)).rejects.toThrow(/forbidden/);
    // Own profile stays readable so the UI can explain the deactivation.
    expect(await count(salesB, "profiles")).toBe(1);
    await asUser(db, admin, (tx) => tx.query("select public.admin_update_user($1, null, null, true)", [salesB]));
    expect(await count(salesB, "leads")).toBeGreaterThan(0);
  });

  it("role change is blocked while the user still owns active leads", async () => {
    await expect(asUser(db, admin, (tx) => tx.query("select public.admin_update_user($1, null, 'account', null)", [salesB]))).rejects.toThrow(/reassign_leads_first/);
  });
});

describe("finance scope", () => {
  it("sales has no finance read or write access; account and admin do", async () => {
    await asUser(db, account, (tx) => tx.query("insert into public.expenses (expense_date, category, amount, created_by) values ('2026-10-01', 'rent', 1000, $1)", [account]));
    expect(await count(account, "expenses")).toBe(1);
    expect(await count(admin, "expenses")).toBe(1);
    expect(await count(salesA, "expenses")).toBe(0);
    expect(await count(salesA, "capital_entries")).toBe(0);
    expect(await count(salesA, "finance_activities")).toBe(0);
    await expect(asUser(db, salesA, (tx) => tx.query("insert into public.expenses (expense_date, category, amount, created_by) values ('2026-10-01', 'rent', 1, $1)", [salesA]))).rejects.toThrow(/row-level security/);
    await expect(asUser(db, salesA, (tx) => tx.query("select public.dashboard_finance(12)"))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, account, (tx) => tx.query("select public.dashboard_admin(30)"))).rejects.toThrow(/forbidden/);
  });
});

describe("worker and linking functions", () => {
  it("are not callable by signed-in users", async () => {
    await expect(asUser(db, admin, (tx) => tx.query("select * from public.claim_due_reminders(10, 60)"))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, admin, (tx) => tx.query("select public.consume_telegram_link_token('x', 1, null)"))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, admin, (tx) => tx.query("select * from public.telegram_link_tokens"))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, admin, (tx) => tx.query("select chat_id from public.telegram_connections"))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, admin, (tx) => tx.query("select lease_token from public.reminder_deliveries"))).rejects.toThrow(/permission denied/);
    await asService(db, (tx) => tx.query("select * from public.claim_due_reminders(10, 60)"));
  });

  it("phone fixture helper produces unique numbers", () => {
    expect(nextPhone()).not.toBe(nextPhone());
  });
});

describe("admin_list_users", () => {
  it("is admin-only, searchable and paginated", async () => {
    const r = await asUser(db, admin, async (tx) => (await one<{ r: { items: { username: string }[]; total: number } }>(tx,
      "select public.admin_list_users('sales', null, 1, 0) as r")).r);
    expect(r.total).toBe(2);
    expect(r.items).toHaveLength(1);
    await expect(asUser(db, salesA, (tx) => tx.query("select public.admin_list_users(null, null, 20, 0)"))).rejects.toThrow(/forbidden/);
  });
});

describe("dashboard date range", () => {
  type Dash = { range: { from: string; to: string; days: number }; trend?: unknown[]; activity?: unknown[] };
  it("uses an explicit IST day range for the trend and rejects a bad one", async () => {
    const a = await asUser(db, admin, async (tx) => (await one<{ r: Dash }>(tx, "select public.dashboard_admin(null, '2026-09-01', '2026-09-30') as r")).r);
    expect(a.range).toEqual({ from: "2026-09-01", to: "2026-09-30", days: 30 });
    expect(a.trend).toHaveLength(30);
    const s = await asUser(db, salesA, async (tx) => (await one<{ r: Dash }>(tx, "select public.dashboard_sales(null, '2026-09-05', '2026-09-05') as r")).r);
    expect(s.activity).toHaveLength(1);
    await expect(asUser(db, admin, (tx) => tx.query("select public.dashboard_admin(null, '2026-09-30', '2026-09-01')"))).rejects.toThrow(/invalid_range/);
    await expect(asUser(db, account, (tx) => tx.query("select public.dashboard_sales(null, '2026-09-01', '2026-09-30')"))).rejects.toThrow(/forbidden/);
  });
});
