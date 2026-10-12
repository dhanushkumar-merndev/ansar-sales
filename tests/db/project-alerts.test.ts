import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createLead, createUser, one, rows, type Db } from "./harness";

let db: Db;
let gardens: string;
let admin: string, bdm: string, manager: string, designer: string, account: string, outsider: string;
let project: string, layout: string;

const kinds = (uid: string, kind: string) =>
  rows<{ payload: Record<string, unknown>; dedupe_key: string }>(db, "select payload, dedupe_key from public.telegram_notifications where recipient_id = $1 and kind = $2 order by created_at", [uid, kind]);
const at = async (hour: number, dayOffset = 0) =>
  (await one<{ t: string }>(db, "select ((now() at time zone 'Asia/Kolkata')::date + $2::int + make_interval(hours => $1)) at time zone 'Asia/Kolkata' as t", [hour, dayOffset])).t;
// Cron runs as the database owner, like here.
const runAlerts = (t: string) => db.query("select private.enqueue_project_alerts($1::timestamptz)", [t]);

beforeAll(async () => {
  db = await createDb();
  gardens = await createCompany(db, "Star Gardens");
  await db.query("update public.companies set features = array['projects'] where id = $1", [gardens]);
  admin = await createUser(db, "al_admin", "admin", "Admin", gardens);
  bdm = await createUser(db, "al_bdm", "sales", "Dhanush", gardens);
  manager = await createUser(db, "al_am", "architect_manager" as never, "Raj", gardens);
  designer = await createUser(db, "al_ld", "landscape_designer" as never, "Diny", gardens);
  account = await createUser(db, "al_acc", "account", "Prema", gardens);
  outsider = await createUser(db, "al_ld2", "landscape_designer" as never, "Abhi", gardens);
  let chat = 9000;
  for (const u of [admin, bdm, manager, designer, account, outsider]) await db.query("insert into public.telegram_connections (user_id, chat_id) values ($1, $2)", [u, chat++]);

  const today = (await one<{ d: string }>(db, "select private.ist_today()::text as d")).d;
  const phases = [
    { category: "Design", name: "Layout", color: "sky", planned_start: today, deadline: today },
    { category: "Design", name: "Deck", color: "sky", planned_start: today, deadline: today },
  ];
  project = await asUser(db, admin, async (tx) => (await one<{ id: string }>(tx,
    `select public.create_project(p_name => 'Hari', p_client_name => 'Hari', p_start => current_date - 30, p_end => current_date + 30,
      p_members => $1::jsonb, p_phases => $2::jsonb,
      p_milestones => '[{"label":"Advance","percent":30,"amount":"100000","due_trigger":"date","due_date":"2020-01-01"}]'::jsonb) as id`,
    [JSON.stringify([{ user_id: manager, role: "architect_manager" }, { user_id: designer, role: "landscape_designer" }]), JSON.stringify(phases)])).id);
  layout = (await one<{ id: string }>(db, "select id from public.project_phases where project_id = $1 and name = 'Layout'", [project])).id;
});

describe("project alerts", () => {
  it("tells admins about a handed-over lead and members when they join", async () => {
    const lead = await createLead(db, bdm, { name: "Hand me" });
    await asUser(db, bdm, (tx) => tx.query("select public.handoff_lead($1, 'Hot lead')", [lead]));
    expect((await kinds(admin, "lead_handed_off")).map((n) => n.payload.lead_name)).toEqual(["Hand me"]);
    expect(await kinds(bdm, "lead_handed_off")).toEqual([]);
    expect(await kinds(designer, "project_assigned")).toHaveLength(1);
    expect(await kinds(admin, "project_assigned")).toEqual([]); // the actor
  });

  it("routes phase ownership, review and changes to the right people", async () => {
    await asUser(db, manager, (tx) => tx.query("update public.project_phases set owner_id = $2 where id = $1", [layout, designer]));
    expect(await kinds(designer, "phase_assigned")).toHaveLength(1);
    await asUser(db, designer, (tx) => tx.query("update public.project_phases set status = 'in_review' where id = $1", [layout]));
    expect(await kinds(manager, "phase_submitted")).toHaveLength(1);
    await asUser(db, manager, (tx) => tx.query("update public.project_phases set status = 'changes_requested', remark = 'Bigger lawn' where id = $1", [layout]));
    const changes = await kinds(designer, "phase_changes");
    expect(changes[0].payload).toMatchObject({ phase: "Layout", remark: "Bigger lawn", project: "Hari" });
  });

  it("sends late-phase alerts once a day, only in the morning window, and stops when done", async () => {
    // Deadlines today: tomorrow they are late.
    await runAlerts(await at(7, 1));
    expect(await kinds(manager, "phase_overdue")).toEqual([]);
    await runAlerts(await at(10, 1));
    await runAlerts(await at(11, 1)); // same day: no repeat
    const first = await kinds(manager, "phase_overdue");
    expect(first.length).toBe(2); // Layout and Deck
    expect(await kinds(admin, "phase_overdue")).toHaveLength(2);
    expect(await kinds(outsider, "phase_overdue")).toEqual([]);
    const deck = (await one<{ id: string }>(db, "select id from public.project_phases where project_id = $1 and name = 'Deck'", [project])).id;
    await asUser(db, manager, (tx) => tx.query("update public.project_phases set status = 'done' where id = $1", [deck]));
    await runAlerts(await at(10, 2));
    const after = await kinds(manager, "phase_overdue");
    expect(after.length - first.length).toBe(1); // only Layout is still late
  });

  it("alerts accounts about due and received payments, never the design team", async () => {
    await runAlerts(await at(9));
    expect((await kinds(account, "payment_due")).map((n) => n.payload.milestone)).toEqual([]); // overdue, not just due
    const monday = await one<{ t: string }>(db,
      "select ((date_trunc('week', now() at time zone 'Asia/Kolkata')::date + 7) + interval '10 hours') at time zone 'Asia/Kolkata' as t");
    await runAlerts(monday.t);
    expect((await kinds(account, "payment_overdue")).map((n) => n.payload.milestone)).toEqual(["Advance"]);
    await asUser(db, account, (tx) => tx.query("insert into public.project_payments (project_id, amount, paid_on, mode) values ($1, 5000, private.ist_today(), 'upi')", [project]));
    expect(await kinds(admin, "payment_received")).toHaveLength(1);
    expect(await kinds(designer, "payment_received")).toEqual([]);
    expect(await kinds(manager, "payment_overdue")).toEqual([]);
  });

  it("reminds the visitor about an hour before a visit, once", async () => {
    await asUser(db, manager, (tx) => tx.query(
      "insert into public.site_visits (project_id, assigned_to, scheduled_at, purpose) values ($1, $2, now() + interval '60 minutes', 'Measure')", [project, manager]));
    await runAlerts(new Date().toISOString());
    await runAlerts(new Date(Date.now() + 5 * 60_000).toISOString());
    expect((await kinds(manager, "site_visit_reminder")).map((n) => n.payload.purpose)).toEqual(["Measure"]);
  });

  it("drops queued project alerts for someone removed from the project", async () => {
    await asUser(db, admin, (tx) => tx.query("select public.set_project_member($1, $2, 'landscape_designer', true)", [project, outsider]));
    await asUser(db, admin, (tx) => tx.query("select public.set_project_member($1, $2, 'landscape_designer', false)", [project, outsider]));
    await asService(db, (tx) => tx.query("select * from public.claim_due_notifications(100, 60)"));
    const r = await one<{ state: string; last_error: string }>(db,
      "select state::text, last_error from public.telegram_notifications where recipient_id = $1 and kind = 'project_assigned'", [outsider]);
    expect(r).toEqual({ state: "skipped", last_error: "no_project_access" });
  });
});
