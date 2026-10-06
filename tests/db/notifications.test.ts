import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createLead, createUser, one, rows, stageId, type Db } from "./harness";

let db: Db;
let admin: string, salesA: string, salesB: string, account: string, offline: string;
const CHAT = { admin: 111, salesA: 222, salesB: 333, account: 444 };

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
  account = await createUser(db, "account", "account", "Account");
  offline = await createUser(db, "sales.offline", "sales", "No Telegram");
  await db.query("insert into public.telegram_connections (user_id, chat_id) values ($1, $2), ($3, $4), ($5, $6), ($7, $8)",
    [admin, CHAT.admin, salesA, CHAT.salesA, salesB, CHAT.salesB, account, CHAT.account]);
});

type Row = { recipient_id: string; kind: string; payload: Record<string, unknown>; state: string; last_error: string | null };
const queued = (where: string, params: unknown[] = []) =>
  rows<Row>(db, `select recipient_id, kind, payload, state::text, last_error from public.telegram_notifications where ${where} order by created_at, id`, params);
const recipients = async (where: string, params: unknown[] = []) => new Set((await queued(where, params)).map((r) => r.recipient_id));
const claimAll = () => asService(db, (tx) => rows<{ notification_id: string; kind: string; chat_id: string }>(tx, "select * from public.claim_due_notifications(100, 60)"));
/** A timestamp today at the given IST hour (cron functions accept a clock for testing). */
const istToday = async (hour: number) =>
  (await one<{ t: string }>(db, "select ((now() at time zone 'Asia/Kolkata')::date + make_interval(hours => $1)) at time zone 'Asia/Kolkata' as t", [hour])).t;

describe("instant events are routed by role and never sent to the actor", () => {
  it("new lead → admins; assignment → new owner", async () => {
    const lead = await createLead(db, salesA, { name: "Routing" });
    expect(await recipients("kind = 'lead_created' and lead_id = $1", [lead])).toEqual(new Set([admin]));
    expect(await queued("lead_id = $1 and recipient_id = $2", [lead, salesA])).toEqual([]); // actor
    await asUser(db, admin, (tx) => tx.query("update public.leads set owner_id = $2 where id = $1", [lead, salesB]));
    const assigned = await queued("kind = 'lead_assigned' and lead_id = $1", [lead]);
    expect(assigned.map((r) => r.recipient_id)).toEqual([salesB]);
    expect(assigned[0].payload).toMatchObject({ lead_name: "Routing", from: "Sales A", actor: "Admin" });
  });

  it("a lead created by Admin for a salesperson notifies that salesperson", async () => {
    const lead = await createLead(db, admin, { name: "For A", ownerId: salesA });
    expect(await recipients("kind = 'lead_assigned' and lead_id = $1", [lead])).toEqual(new Set([salesA]));
    expect(await recipients("kind = 'lead_created' and lead_id = $1", [lead])).toEqual(new Set()); // only admin, who acted
  });

  it("won/lost → admins; someone else's follow-up change → assignee", async () => {
    const lead = await createLead(db, salesA, { name: "Closing" });
    const won = await stageId(db, "Won");
    await asUser(db, salesA, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [lead, won]));
    const closed = await queued("kind = 'lead_closed' and lead_id = $1", [lead]);
    expect(closed.map((r) => [r.recipient_id, r.payload.status])).toEqual([[admin, "won"]]);
    await asUser(db, salesA, (tx) => tx.query("insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, 'Own task', now() + interval '1 day', $2)", [lead, salesA]));
    await asUser(db, admin, (tx) => tx.query("insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, 'From admin', now() + interval '1 day', $2)", [lead, admin]));
    const changed = await queued("kind = 'follow_up_changed' and lead_id = $1", [lead]);
    expect(changed.map((r) => [r.recipient_id, r.payload.task])).toEqual([[salesA, "From admin"]]);
  });

  it("finance entries → admin + account, never sales", async () => {
    const e = await asUser(db, account, async (tx) => (await one<{ id: string }>(tx,
      "insert into public.expenses (expense_date, category, amount, created_by) values (current_date, 'rent', 25000, $1) returning id", [account])).id);
    expect(await recipients("kind = 'expense_added' and payload ->> 'id' = $1", [e])).toEqual(new Set([admin]));
    const c = await asUser(db, admin, async (tx) => (await one<{ id: string }>(tx,
      "insert into public.capital_entries (entry_date, contributor, amount, created_by) values (current_date, 'Founder', 100000, $1) returning id", [admin])).id);
    expect(await recipients("kind = 'capital_added' and payload ->> 'id' = $1", [c])).toEqual(new Set([account]));
  });

  it("library uploads → admin + other sales, never account", async () => {
    const folder = await asUser(db, salesA, async (tx) => (await one<{ id: string }>(tx, "insert into public.library_folders (name) values ('Decks') returning id")).id);
    const path = `${folder}/${randomUUID()}.pdf`;
    await asUser(db, salesA, (tx) => tx.query("insert into storage.objects (bucket_id, name, owner, metadata) values ('library', $1, $2, $3)",
      [path, salesA, { size: 10, mimetype: "application/pdf" }]));
    const file = await asUser(db, salesA, async (tx) => (await one<{ id: string }>(tx,
      "insert into public.library_files (folder_id, name, storage_path) values ($1, 'Pitch.pdf', $2) returning id", [folder, path])).id);
    const rowsForFile = await queued("kind = 'library_file_added' and payload ->> 'id' = $1", [file]);
    expect(new Set(rowsForFile.map((r) => r.recipient_id))).toEqual(new Set([admin, salesB])); // offline user has no Telegram
    expect(rowsForFile[0].payload).toMatchObject({ name: "Pitch.pdf", folder: "Decks", folder_id: folder, actor: "Sales A" });
  });
});

describe("preferences and delivery-time checks", () => {
  it("a disabled kind is not queued and an unavailable kind is rejected", async () => {
    await asUser(db, salesB, (tx) => tx.query("select public.set_notification_pref('lead_assigned', false)"));
    const lead = await createLead(db, admin, { name: "Muted", ownerId: salesB });
    expect(await queued("kind = 'lead_assigned' and lead_id = $1", [lead])).toEqual([]);
    await asUser(db, salesB, (tx) => tx.query("select public.set_notification_pref('lead_assigned', true)"));
    await expect(asUser(db, account, (tx) => tx.query("select public.set_notification_pref('lead_created', false)"))).rejects.toThrow(/invalid_kind/);
    await expect(asUser(db, salesA, (tx) => tx.query("select public.set_notification_pref('expense_added', false)"))).rejects.toThrow(/invalid_kind/);
  });

  it("skips a lead message once the recipient lost access, and only the service role can claim", async () => {
    const lead = await createLead(db, admin, { name: "Moved again", ownerId: salesA });
    await asUser(db, admin, (tx) => tx.query("update public.leads set owner_id = $2 where id = $1", [lead, salesB]));
    await claimAll();
    const forA = await queued("kind = 'lead_assigned' and lead_id = $1 and recipient_id = $2", [lead, salesA]);
    expect(forA.map((r) => [r.state, r.last_error])).toEqual([["skipped", "no_lead_access"]]);
    const forB = await queued("kind = 'lead_assigned' and lead_id = $1 and recipient_id = $2", [lead, salesB]);
    expect(forB.map((r) => r.state)).toEqual(["processing"]);
    await expect(asUser(db, admin, (tx) => tx.query("select * from public.claim_due_notifications(10, 60)"))).rejects.toThrow(/permission denied/);
  });

  it("test message requires a connected Telegram", async () => {
    await asUser(db, salesA, (tx) => tx.query("select public.send_test_notification()"));
    expect(await recipients("kind = 'test' and recipient_id = $1", [salesA])).toEqual(new Set([salesA]));
    await expect(asUser(db, salesA, (tx) => tx.query("select public.send_test_notification()"))).rejects.toThrow(/test_too_soon/);
    await expect(asUser(db, offline, (tx) => tx.query("select public.send_test_notification()"))).rejects.toThrow(/telegram_not_connected/);
  });
});

describe("overdue alerts", () => {
  let lead: string, fu: string;
  const nags = () => queued("kind = 'overdue_nag' and follow_up_id = $1", [fu]);
  const enqueue = async (hour: number) => one<{ n: number }>(db, "select private.enqueue_overdue_nags($1) as n", [await istToday(hour)]);

  beforeAll(async () => {
    lead = await createLead(db, salesA, { name: "Late" });
    // Due yesterday 10:00 IST: always in the past and before the simulated noon runs.
    const due = await istToday(-14);
    fu = await asUser(db, salesA, async (tx) => (await one<{ id: string }>(tx,
      "insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, 'Call now', $2, $3) returning id", [lead, due, salesA])).id);
  });

  it("pause at night, then one alert per run with no backlog while one is undelivered", async () => {
    await enqueue(23);
    expect(await nags()).toEqual([]);
    await enqueue(12);
    await enqueue(12);
    const first = await nags();
    expect(first.map((r) => [r.recipient_id, r.state])).toEqual([[salesA, "pending"]]);
    expect(first[0].payload).toMatchObject({ lead_name: "Late", task: "Call now", follow_up_id: fu, revision: 1 });
  });

  it("silence works only from the assignee's chat and stops further alerts", async () => {
    const wrong = await asService(db, async (tx) => (await one<{ r: { ok: boolean } }>(tx, "select public.silence_follow_up_nag($1, $2) as r", [CHAT.salesB, fu])).r);
    expect(wrong.ok).toBe(false);
    await expect(asUser(db, salesA, (tx) => tx.query("select public.silence_follow_up_nag($1, $2)", [CHAT.salesA, fu]))).rejects.toThrow(/permission denied/);
    const ok = await asService(db, async (tx) => (await one<{ r: { ok: boolean; lead_name: string } }>(tx, "select public.silence_follow_up_nag($1, $2) as r", [CHAT.salesA, fu])).r);
    expect(ok).toEqual({ ok: true, lead_name: "Late" });
    expect((await nags()).map((r) => [r.state, r.last_error])).toEqual([["cancelled", "silenced"]]);
    await enqueue(12);
    expect(await nags()).toHaveLength(1);
  });

  it("rescheduling re-arms alerts; completing stops them at delivery", async () => {
    const due = await istToday(-13);
    await asUser(db, salesA, (tx) => tx.query("update public.follow_ups set due_at = $2 where id = $1", [fu, due]));
    await enqueue(13);
    const afterReschedule = await nags();
    expect(afterReschedule).toHaveLength(2);
    expect(afterReschedule[1]).toMatchObject({ state: "pending", payload: expect.objectContaining({ revision: 2 }) });
    await asUser(db, salesA, (tx) => tx.query("update public.follow_ups set state = 'completed' where id = $1", [fu]));
    await claimAll();
    expect((await nags())[1]).toMatchObject({ state: "cancelled", last_error: "no_longer_overdue" });
  });
});

describe("digests", () => {
  it("sales morning list once per day, only for users with tasks", async () => {
    const lead = await createLead(db, salesB, { name: "Digest" });
    await asUser(db, salesB, (tx) => tx.query(
      "insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, 'Today task', now() + interval '1 minute', $2)", [lead, salesB]));
    const at9 = await istToday(9);
    await one(db, "select private.enqueue_digests($1)", [at9]);
    await one(db, "select private.enqueue_digests($1)", [at9]);
    const digests = await queued("kind = 'digest_sales' and recipient_id = $1", [salesB]);
    expect(digests).toHaveLength(1);
    expect(Number(digests[0].payload.today) + Number(digests[0].payload.overdue)).toBeGreaterThan(0);
    expect(await queued("kind = 'digest_sales' and recipient_id = $1", [account])).toEqual([]);
  });

  it("admin team report at 8 PM lists each salesperson", async () => {
    await one(db, "select private.enqueue_digests($1)", [await istToday(20)]);
    const report = await queued("kind = 'digest_admin'");
    expect(report.map((r) => r.recipient_id)).toEqual([admin]);
    const names = (report[0].payload.rows as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["Sales A", "Sales B"]));
    expect(names).not.toContain("Account");
  });

  it("finance summary only on the 1st, to admin + account", async () => {
    const first = (await one<{ t: string }>(db,
      "select (date_trunc('month', (now() at time zone 'Asia/Kolkata')) + interval '9 hours 30 minutes') at time zone 'Asia/Kolkata' as t")).t;
    const second = (await one<{ t: string }>(db, "select $1::timestamptz + interval '1 day' as t", [first])).t;
    await one(db, "select private.enqueue_digests($1)", [second]);
    expect(await queued("kind = 'digest_finance'")).toEqual([]);
    await one(db, "select private.enqueue_digests($1)", [first]);
    expect(await recipients("kind = 'digest_finance'")).toEqual(new Set([admin, account]));
  });
});
