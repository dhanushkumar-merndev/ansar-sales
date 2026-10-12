import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createUser, one, rows, type Db } from "./harness";

let db: Db;
let gardens: string;
let admin: string, account: string, manager: string, designer: string, bdm: string;
let project: string;

type Status = { money: boolean; received: number | null; contract_value: number | null; extra?: number; ahead?: number; schedule_open?: number; milestones: { id: string; label: string; status: string; amount?: number; paid?: number; balance?: number }[] };
const status = (uid: string) => asUser(db, uid, async (tx) => (await one<{ s: Status }>(tx, "select public.project_payment_status($1) as s", [project])).s);

beforeAll(async () => {
  db = await createDb();
  gardens = await createCompany(db, "Star Gardens");
  await db.query("update public.companies set features = array['projects'] where id = $1", [gardens]);
  admin = await createUser(db, "pa_admin", "admin", "Admin", gardens);
  account = await createUser(db, "pa_acc", "account", "Prema", gardens);
  manager = await createUser(db, "pa_am", "architect_manager" as never, "Raj", gardens);
  designer = await createUser(db, "pa_ld", "landscape_designer" as never, "Diny", gardens);
  bdm = await createUser(db, "pa_bdm", "sales", "Dhanush", gardens);
  const phases = [
    { category: "Design", name: "Design development", color: "sky", planned_start: "2026-01-01", deadline: "2026-01-10" },
    { category: "Design", name: "BOQ R2", color: "violet", planned_start: "2026-01-11", deadline: "2026-01-15" },
  ];
  const milestones = [
    { label: "Advance", percent: 30, amount: "234000.30", due_trigger: "date", due_date: "2026-01-01" },
    { label: "After design", percent: 20, amount: "156000", due_trigger: "phase", phase_index: 1 },
    { label: "Final", percent: 50, amount: "390000", due_trigger: "date", due_date: "2099-01-01" },
  ];
  project = await asUser(db, admin, async (tx) => (await one<{ id: string }>(tx,
    `select public.create_project(p_name => 'Hari', p_client_name => 'Hari', p_start => '2026-01-01', p_end => '2026-03-01',
      p_contract_value => 780000.30, p_members => $1::jsonb, p_phases => $2::jsonb, p_milestones => $3::jsonb) as id`,
    [JSON.stringify([{ user_id: manager, role: "architect_manager" }, { user_id: designer, role: "landscape_designer" }]), JSON.stringify(phases), JSON.stringify(milestones)])).id);
});

describe("payment schedule", () => {
  it("creates the schedule with the project, linked to its phases", async () => {
    const s = await status(account);
    expect(s.milestones.map((m) => [m.label, m.status])).toEqual([["Advance", "overdue"], ["After design", "upcoming"], ["Final", "upcoming"]]);
    expect(Number(s.contract_value)).toBe(780000.3);
  });

  it("records part payments exactly and derives paid / partly paid", async () => {
    const advance = (await status(account)).milestones[0].id;
    await asUser(db, account, (tx) => tx.query(
      "insert into public.project_payments (project_id, milestone_id, amount, paid_on, mode, reference) values ($1, $2, 100000.10, '2026-01-02', 'upi', 'UTR123')", [project, advance]));
    let m = (await status(account)).milestones[0];
    expect(m.status).toBe("overdue"); // still short, and more than a week past due
    expect(Number(m.balance)).toBe(134000.2);
    await asUser(db, account, (tx) => tx.query(
      "insert into public.project_payments (project_id, milestone_id, amount, paid_on, mode) values ($1, $2, 134000.20, '2026-01-05', 'cheque')", [project, advance]));
    m = (await status(account)).milestones[0];
    expect(m.status).toBe("paid");
    expect(Number(m.paid)).toBe(234000.3);
    expect(Number((await status(account)).received)).toBe(234000.3);
  });

  it("makes a phase-linked milestone due when the phase is done", async () => {
    const ph = (await one<{ id: string }>(db, "select id from public.project_phases where project_id = $1 and name = 'Design development'", [project])).id;
    await asUser(db, manager, (tx) => tx.query("update public.project_phases set status = 'done', submitted_on = private.ist_today() where id = $1", [ph]));
    expect((await status(account)).milestones[1].status).toBe("due");
  });

  it("shows money to Admin and Accounts only: the architect manager and the team are refused", async () => {
    await expect(status(manager)).rejects.toThrow(/forbidden/);
    await expect(status(designer)).rejects.toThrow(/forbidden/);
    await expect(status(bdm)).rejects.toThrow(/not_found/);
    expect((await status(admin)).money).toBe(true);
    await expect(asUser(db, manager, (tx) => rows(tx, "select * from public.project_payments"))).resolves.toEqual([]);
    await expect(asUser(db, manager, (tx) => tx.query(
      "insert into public.project_payments (project_id, amount, paid_on, mode) values ($1, 1, '2026-01-01', 'cash')", [project]))).rejects.toThrow();
  });

  it("lists dues across projects and totals the month", async () => {
    const dues = await asUser(db, account, async (tx) => (await one<{ d: { total: number; items: { label: string }[] } }>(tx, "select public.list_payment_dues('due') as d")).d);
    expect(dues.items.map((i) => i.label)).toEqual(["After design"]);
    const received = await asUser(db, account, async (tx) => (await one<{ r: { sum: number; total: number; by_mode: Record<string, number> } }>(tx,
      "select public.list_payments_received('2026-01-01', '2026-01-31') as r")).r);
    expect(Number(received.sum)).toBe(234000.3);
    expect(Number(received.by_mode.upi)).toBe(100000.1);
    await expect(asUser(db, designer, (tx) => tx.query("select public.payments_overview()"))).rejects.toThrow(/forbidden/);
  });

  it("keeps payment events out of the team's activity feed", async () => {
    const feed = (uid: string) => asUser(db, uid, async (tx) => (await one<{ f: { items: { type: string }[] } }>(tx, "select public.list_project_activities($1, 100) as f", [project])).f.items.map((a) => a.type));
    expect(await feed(account)).toContain("payment_recorded");
    expect(await feed(designer)).not.toContain("payment_recorded");
  });
  it("applies any amount to the oldest open part first, and keeps the rest due", async () => {
    // Advance is paid (234000.30). 200000 more: covers "After design" (156000) fully, 44000 goes to "Final".
    await asUser(db, account, (tx) => tx.query(
      "insert into public.project_payments (project_id, amount, paid_on, mode) values ($1, 200000, '2026-01-10', 'bank_transfer')", [project]));
    let s = await status(account);
    expect(s.milestones.map((m) => [m.label, m.status, Number(m.paid), Number(m.balance)])).toEqual([
      ["Advance", "paid", 234000.3, 0],
      ["After design", "paid", 156000, 0],
      ["Final", "partly_paid", 44000, 346000],
    ]);
    expect(Number(s.schedule_open)).toBe(346000);
    // An extra (outside the schedule) is counted as received but never pays a part.
    await asUser(db, account, (tx) => tx.query(
      "insert into public.project_payments (project_id, amount, paid_on, mode, is_extra) values ($1, 5000, '2026-01-11', 'cash', true)", [project]));
    s = await status(account);
    expect(Number(s.milestones[2].paid)).toBe(44000);
    expect(Number(s.extra)).toBe(5000);
    expect(Number(s.received)).toBe(439000.3);
    // Paying more than the whole schedule shows as "ahead".
    const big = await asUser(db, account, async (tx) => (await one<{ id: string }>(tx,
      "insert into public.project_payments (project_id, amount, paid_on, mode) values ($1, 400000, '2026-01-12', 'cheque') returning id", [project])).id);
    s = await status(account);
    expect(s.milestones[2].status).toBe("paid");
    expect(Number(s.ahead)).toBe(54000);
    // Removing a payment puts the balance back.
    await asUser(db, account, (tx) => tx.query("update public.project_payments set archived_at = now() where id = $1", [big]));
    expect((await status(account)).milestones[2].status).toBe("partly_paid");
  });
});
