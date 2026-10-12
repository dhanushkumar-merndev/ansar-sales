import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createUser, one, rows, type Db } from "./harness";

let db: Db;
let admin: string, manager: string, designer: string, execution: string, account: string;
let project: string;

const boq = (uid: string) => asUser(db, uid, async (tx) => (await one<{ b: { id: string; label: string; status: string; total: number; items: { id: string; amount: number }[] }[] }>(tx,
  "select public.project_boq($1) as b", [project])).b);

beforeAll(async () => {
  db = await createDb();
  const gardens = await createCompany(db, "Star Gardens");
  await db.query("update public.companies set features = array['projects'] where id = $1", [gardens]);
  admin = await createUser(db, "ex_admin", "admin", "Admin", gardens);
  manager = await createUser(db, "ex_am", "architect_manager" as never, "Raj", gardens);
  designer = await createUser(db, "ex_ld", "landscape_designer" as never, "Diny", gardens);
  execution = await createUser(db, "ex_ex", "execution" as never, "Abhi", gardens);
  account = await createUser(db, "ex_acc", "account", "Prema", gardens);
  project = await asUser(db, admin, async (tx) => (await one<{ id: string }>(tx,
    `select public.create_project(p_name => 'Hari', p_client_name => 'Hari', p_start => '2026-10-01', p_end => '2026-11-01', p_members => $1::jsonb) as id`,
    [JSON.stringify([{ user_id: manager, role: "architect_manager" }, { user_id: designer, role: "landscape_designer" }, { user_id: execution, role: "execution" }])])).id);
});

describe("BOQ", () => {
  let r2: string;
  it("lets the designer build a draft with exact amounts", async () => {
    r2 = await asUser(db, designer, async (tx) => (await one<{ id: string }>(tx, "insert into public.project_boq_revisions (project_id, label) values ($1, 'r2') returning id", [project])).id);
    await asUser(db, designer, (tx) => tx.query(
      `insert into public.project_boq_items (revision_id, section, item, unit, qty, rate) values
        ($1, 'Hardscape', 'Granite paving', 'sqft', 120.5, 85.25), ($1, 'Softscape', 'Mexican grass', 'sqft', 780, 18)`, [r2]));
    const b = await boq(manager);
    expect(b[0].label).toBe("R2");
    expect(Number(b[0].total)).toBe(Math.round((120.5 * 85.25 + 780 * 18) * 100) / 100);
    await expect(asUser(db, execution, (tx) => tx.query("insert into public.project_boq_items (revision_id, item) values ($1, 'x')", [r2]))).rejects.toThrow(/forbidden/);
  });

  it("locks a sent revision, but execution still records progress", async () => {
    await expect(asUser(db, designer, (tx) => tx.query("update public.project_boq_revisions set status = 'sent' where id = $1", [r2]))).rejects.toThrow(/forbidden/);
    await asUser(db, manager, (tx) => tx.query("update public.project_boq_revisions set status = 'client_approved' where id = $1", [r2]));
    const item = (await boq(manager))[0].items[0].id;
    await expect(asUser(db, designer, (tx) => tx.query("update public.project_boq_items set qty = 1 where id = $1", [item]))).rejects.toThrow(/boq_locked/);
    await asUser(db, execution, (tx) => tx.query("update public.project_boq_items set executed_qty = 60 where id = $1", [item]));
    expect(Number((await one<{ executed_qty: string }>(db, "select executed_qty from public.project_boq_items where id = $1", [item])).executed_qty)).toBe(60);
  });

  it("copies a revision into the next draft and approving it supersedes the old one", async () => {
    const r3 = await asUser(db, designer, async (tx) => (await one<{ id: string }>(tx, "select public.copy_boq_revision($1, 'R3') as id", [r2])).id);
    expect((await boq(designer)).find((r) => r.id === r3)!.items).toHaveLength(2);
    await asUser(db, manager, (tx) => tx.query("update public.project_boq_revisions set status = 'client_approved' where id = $1", [r3]));
    const statuses = Object.fromEntries((await boq(manager)).map((r) => [r.label, r.status]));
    expect(statuses).toEqual({ R2: "superseded", R3: "client_approved" });
    await expect(boq(account)).rejects.toThrow(/not_found/);
  });
});

describe("site logs, snags and my work", () => {
  it("records one log per person per day and lists my sites", async () => {
    await asUser(db, execution, (tx) => tx.query("insert into public.project_site_logs (project_id, log_date, workers, issues) values ($1, private.ist_today(), 6, 'Rain in the afternoon')", [project]));
    await expect(asUser(db, execution, (tx) => tx.query("insert into public.project_site_logs (project_id, log_date) values ($1, private.ist_today())", [project]))).rejects.toThrow();
    await expect(asUser(db, execution, (tx) => tx.query("insert into public.project_site_logs (project_id, log_date) values ($1, private.ist_today() + 1)", [project]))).rejects.toThrow(/future_log/);
    const work = await asUser(db, execution, async (tx) => (await one<{ w: { sites: { id: string; logged_today: boolean }[] } }>(tx, "select public.my_work() as w")).w);
    expect(work.sites).toEqual([expect.objectContaining({ id: project, logged_today: true })]);
  });

  it("tracks snags to fixed; only the manager verifies", async () => {
    const snag = await asUser(db, manager, async (tx) => (await one<{ id: string }>(tx,
      "insert into public.project_snags (project_id, title, owner_id) values ($1, 'Fix drip line near the gate', $2) returning id", [project, execution])).id);
    await asUser(db, execution, (tx) => tx.query("update public.project_snags set status = 'fixed' where id = $1", [snag]));
    await expect(asUser(db, execution, (tx) => tx.query("update public.project_snags set status = 'verified' where id = $1", [snag]))).rejects.toThrow(/forbidden/);
    await asUser(db, manager, (tx) => tx.query("update public.project_snags set status = 'verified' where id = $1", [snag]));
    const s = await one<{ status: string; fixed_by: string }>(db, "select status, fixed_by from public.project_snags where id = $1", [snag]);
    expect(s).toEqual({ status: "verified", fixed_by: execution });
    await expect(asUser(db, account, (tx) => rows(tx, "select id from public.project_snags"))).resolves.toEqual([]);
  });
});
