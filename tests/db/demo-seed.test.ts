import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createUser, one, type Db } from "./harness";

const seed = (name: string) => readFileSync(join(__dirname, "..", "..", "supabase", "seed", name), "utf8");
let db: Db;
let admin: string;

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "real.admin", "admin", "Real Admin");
  for (const [u, role, name] of [["demo_sales_1", "sales", "Demo Sales 1"], ["demo_sales_2", "sales", "Demo Sales 2"], ["demo_sales_3", "sales", "Demo Sales 3"],
    ["demo_sales_4", "sales", "Demo Sales 4 (left)"], ["demo_account", "account", "Demo Account"]] as const) await createUser(db, u, role, name);
  await db.query("update public.profiles set is_active = false where username like 'demo\\_%'");
}, 60_000);

describe("demo seed", () => {
  it("creates about 1,000 records that satisfy every constraint and feed the reports, then cleans up completely", async () => {
    await db.exec(seed("demo.sql"));
    const c = await one<Record<string, number>>(db, `select
      (select count(*)::int from public.leads) as leads, (select count(*)::int from public.follow_ups) as follow_ups,
      (select count(*)::int from public.expenses) as expenses, (select count(*)::int from public.capital_entries) as capital,
      (select count(*)::int from public.reminder_deliveries) as reminders, (select count(distinct stage_id)::int from public.leads) as statuses,
      (select count(distinct state)::int from public.follow_ups) as states`);
    expect(c.leads).toBe(600);
    expect(c.follow_ups).toBe(250);
    expect(c.leads + c.follow_ups + c.expenses + c.capital).toBeGreaterThanOrEqual(1000);
    expect(c.reminders).toBe(0); // no Telegram reminders queued for demo follow-ups
    expect(c.statuses).toBe(6);
    expect(c.states).toBe(3);
    // Pending follow-ups always belong to the lead's current owner.
    expect((await one<{ n: number }>(db, "select count(*)::int as n from public.follow_ups f join public.leads l on l.id = f.lead_id where f.state = 'pending' and f.assignee_id <> l.owner_id")).n).toBe(0);
    // Stage history is consistent with the current stage, and status is the stage's kind.
    expect((await one<{ n: number }>(db, `select count(*)::int as n from public.leads l join public.pipeline_stages s on s.id = l.stage_id
      where s.name <> 'New' and l.stage_id::text <> (
      select a.meta ->> 'to_stage_id' from public.lead_activities a where a.lead_id = l.id and a.type = 'status_changed' order by a.created_at desc limit 1)`)).n).toBe(0);
    expect((await one<{ n: number }>(db, "select count(*)::int as n from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.status <> s.kind")).n).toBe(0);
    await expect(db.exec(seed("demo.sql"))).rejects.toThrow(/already present/);

    const year = await asUser(db, admin, async (tx) => (await one<{ r: { cards: Record<string, number> } }>(tx,
      "select public.report_leads((private.ist_today() - 365), private.ist_today()) as r")).r);
    expect(year.cards.created).toBeGreaterThan(400);
    expect(year.cards.won).toBeGreaterThan(30);
    const fin = await asUser(db, admin, async (tx) => (await one<{ r: { cards: Record<string, number>; items: unknown[] } }>(tx,
      "select public.report_finance((private.ist_today() - 365), private.ist_today()) as r")).r);
    expect(Number(fin.cards.expense_total)).toBeLessThan(1e9); // the huge archived amount is excluded
    expect(fin.items.length).toBeGreaterThan(5);

    await db.exec(seed("demo-clean.sql"));
    const left = await one<Record<string, number>>(db, `select
      (select count(*)::int from public.leads) + (select count(*)::int from public.follow_ups) + (select count(*)::int from public.lead_activities)
      + (select count(*)::int from public.expenses) + (select count(*)::int from public.capital_entries) + (select count(*)::int from public.finance_activities)
      + (select count(*)::int from public.expense_recurrences) + (select count(*)::int from public.niches) as n`);
    expect(left.n).toBe(0);
  }, 120_000);
});
