import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createLead, createUser, one, rows, type Db } from "./harness";

type Claim = { delivery_id: string; lease_token: string; chat_id: number; lead_name: string; task: string; attempts: number };

let db: Db;
let admin: string, salesA: string, salesB: string;

const claim = (limit = 25, lease = 120) =>
  asService(db, (tx) => rows<Claim>(tx, "select * from public.claim_due_reminders($1, $2)", [limit, lease]));
const finish = (c: Claim, result: string, error: string | null = null, retryAfter: number | null = null, token = c.lease_token) =>
  asService(db, async (tx) => (await one<{ r: string }>(tx, "select public.finish_reminder($1, $2, $3, $4, $5) as r", [c.delivery_id, token, result, error, retryAfter])).r);
const deliveries = (leadId: string) =>
  rows<{ revision: number; state: string; attempts: number; last_error: string | null }>(db,
    `select d.revision, d.state, d.attempts, d.last_error from public.reminder_deliveries d
     join public.follow_ups f on f.id = d.follow_up_id where f.lead_id = $1 order by d.revision`, [leadId]);

async function link(userId: string, chatId: number) {
  const token = await asUser(db, userId, async (tx) => (await one<{ t: string }>(tx, "select public.create_telegram_link_token() as t")).t);
  return asService(db, async (tx) => (await one<{ r: { ok: boolean } }>(tx, "select public.consume_telegram_link_token($1, $2, 'tg') as r", [token, chatId])).r);
}

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
});

beforeEach(async () => {
  // Isolate each test: close out anything still due from earlier tests.
  await db.query("update public.reminder_deliveries set state = 'cancelled' where state in ('pending', 'processing')");
});

describe("telegram linking", () => {
  it("requires a valid, unexpired, single-use token", async () => {
    const token = await asUser(db, salesA, async (tx) => (await one<{ t: string }>(tx, "select public.create_telegram_link_token() as t")).t);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const stored = await one<{ token_hash: string }>(db, "select token_hash from public.telegram_link_tokens where user_id = $1", [salesA]);
    expect(stored.token_hash).not.toBe(token);
    const bad = await asService(db, async (tx) => (await one<{ r: { ok: boolean } }>(tx, "select public.consume_telegram_link_token($1, 111, null) as r", ["0".repeat(64)])).r);
    expect(bad.ok).toBe(false);
    const ok = await asService(db, async (tx) => (await one<{ r: { ok: boolean } }>(tx, "select public.consume_telegram_link_token($1, 111, 'a') as r", [token])).r);
    expect(ok.ok).toBe(true);
    const reused = await asService(db, async (tx) => (await one<{ r: { ok: boolean } }>(tx, "select public.consume_telegram_link_token($1, 222, 'b') as r", [token])).r);
    expect(reused.ok).toBe(false);
    const own = await asUser(db, salesA, (tx) => rows(tx, "select status, telegram_username from public.telegram_connections"));
    expect(own).toEqual([{ status: "connected", telegram_username: "a" }]);
    expect(await asUser(db, salesB, (tx) => rows(tx, "select user_id from public.telegram_connections"))).toEqual([]);
  });

  it("rejects expired tokens", async () => {
    const token = await asUser(db, salesB, async (tx) => (await one<{ t: string }>(tx, "select public.create_telegram_link_token() as t")).t);
    await db.query("update public.telegram_link_tokens set expires_at = now() - interval '1 minute' where user_id = $1", [salesB]);
    const r = await asService(db, async (tx) => (await one<{ r: { ok: boolean } }>(tx, "select public.consume_telegram_link_token($1, 333, null) as r", [token])).r);
    expect(r.ok).toBe(false);
  });
});

describe("reminder worker", () => {
  beforeAll(async () => {
    await link(salesA, 1001);
  });

  it("does not claim future reminders", async () => {
    await createLead(db, salesA, { followUpAt: "2099-01-01T00:00:00Z" });
    expect(await claim()).toEqual([]);
  });

  it("claims a due reminder once, even when runs overlap", async () => {
    const lead = await createLead(db, salesA, { name: "Due Lead", followUpAt: new Date(Date.now() - 60_000).toISOString() });
    const first = await claim();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ chat_id: 1001, lead_name: "Due Lead", task: "Follow up", attempts: 1 });
    expect(await claim()).toEqual([]); // second overlapping run sees the active lease
    expect(await finish(first[0], "sent")).toBe("sent");
    expect(await deliveries(lead)).toEqual([{ revision: 1, state: "sent", attempts: 1, last_error: null }]);
    expect(await finish(first[0], "sent")).toBe("lease_lost"); // completion is idempotent per lease
  });

  it("reclaims work whose lease expired after a crash", async () => {
    const lead = await createLead(db, salesA, { followUpAt: new Date(Date.now() - 60_000).toISOString() });
    const [c] = await claim();
    await db.query("update public.reminder_deliveries set next_attempt_at = now() - interval '1 second' where id = $1", [c.delivery_id]);
    const [again] = await claim();
    expect(again.delivery_id).toBe(c.delivery_id);
    expect(again.attempts).toBe(2);
    expect(await finish(c, "sent")).toBe("lease_lost"); // stale worker cannot overwrite
    expect(await finish(again, "sent")).toBe("sent");
    expect((await deliveries(lead))[0].state).toBe("sent");
  });

  it("retries temporary failures with backoff and gives up after max attempts", async () => {
    const lead = await createLead(db, salesA, { followUpAt: new Date(Date.now() - 60_000).toISOString() });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const [c] = await claim();
      expect(c.attempts).toBe(attempt);
      const r = await finish(c, "retry", "telegram 502", null);
      expect(r).toBe(attempt < 5 ? "pending" : "failed");
      const d = await one<{ wait: number }>(db,
        "select extract(epoch from next_attempt_at - now())::int as wait from public.reminder_deliveries where id = $1", [c.delivery_id]);
      if (attempt < 5) {
        expect(d.wait).toBeGreaterThanOrEqual(30);
        expect(await claim()).toEqual([]); // not yet due again
        await db.query("update public.reminder_deliveries set next_attempt_at = now() where id = $1", [c.delivery_id]);
      }
    }
    expect(await deliveries(lead)).toEqual([{ revision: 1, state: "failed", attempts: 5, last_error: "telegram 502" }]);
  });

  it("honours Telegram retry_after", async () => {
    await createLead(db, salesA, { followUpAt: new Date(Date.now() - 60_000).toISOString() });
    const [c] = await claim();
    await finish(c, "retry", "429", 600);
    const d = await one<{ wait: number }>(db, "select extract(epoch from next_attempt_at - now())::int as wait from public.reminder_deliveries where id = $1", [c.delivery_id]);
    expect(d.wait).toBeGreaterThan(590);
  });

  it("rescheduling supersedes the old revision transactionally", async () => {
    const lead = await createLead(db, salesA, { followUpAt: "2099-01-01T00:00:00Z" });
    const fu = await one<{ id: string }>(db, "select id from public.follow_ups where lead_id = $1", [lead]);
    await asUser(db, salesA, (tx) => tx.query("update public.follow_ups set due_at = now() - interval '1 minute' where id = $1", [fu.id]));
    expect(await deliveries(lead)).toMatchObject([
      { revision: 1, state: "cancelled", last_error: "superseded" },
      { revision: 2, state: "pending" },
    ]);
    const claimed = await claim();
    expect(claimed).toHaveLength(1);
    await finish(claimed[0], "sent");
    const act = await one<{ type: string }>(db, "select type from public.lead_activities where lead_id = $1 and type = 'follow_up_rescheduled'", [lead]);
    expect(act.type).toBe("follow_up_rescheduled");
  });

  it("does not send completed, cancelled or archived-lead reminders", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const l1 = await createLead(db, salesA, { followUpAt: past });
    const l2 = await createLead(db, salesA, { followUpAt: past });
    const l3 = await createLead(db, salesA, { followUpAt: past });
    const id1 = (await one<{ id: string }>(db, "select id from public.follow_ups where lead_id = $1", [l1])).id;
    const id2 = (await one<{ id: string }>(db, "select id from public.follow_ups where lead_id = $1", [l2])).id;
    await asUser(db, salesA, (tx) => tx.query("select public.complete_follow_up($1, 'done')", [id1]));
    await asUser(db, salesA, (tx) => tx.query("update public.follow_ups set state = 'cancelled' where id = $1", [id2]));
    await asUser(db, admin, (tx) => tx.query("update public.leads set archived_at = now() where id = $1", [l3]));
    expect(await claim()).toEqual([]);
    expect((await deliveries(l1))[0].state).toBe("cancelled");
    expect((await deliveries(l2))[0].state).toBe("cancelled");
    expect((await deliveries(l3))[0]).toMatchObject({ state: "skipped", last_error: "lead_archived" });
  });

  it("marks reminders for users without Telegram as failed (visible), not sent", async () => {
    const lead = await createLead(db, salesB, { followUpAt: new Date(Date.now() - 60_000).toISOString() });
    expect(await claim()).toEqual([]);
    expect((await deliveries(lead))[0]).toMatchObject({ state: "failed", last_error: "telegram_not_connected" });
    const visible = await asUser(db, salesB, async (tx) =>
      (await one<{ r: { items: { reminder: { state: string; last_error: string } }[] } }>(tx, "select public.list_follow_ups('overdue', null, null, 20, 0) as r")).r);
    expect(visible.items[0].reminder).toMatchObject({ state: "failed", last_error: "telegram_not_connected" });
  });

  it("marks the connection blocked when the user blocked the bot", async () => {
    await createLead(db, salesA, { followUpAt: new Date(Date.now() - 60_000).toISOString() });
    const [c] = await claim();
    expect(await finish(c, "blocked", "Forbidden: bot was blocked by the user")).toBe("failed");
    const conn = await one<{ status: string }>(db, "select status from public.telegram_connections where user_id = $1", [salesA]);
    expect(conn.status).toBe("blocked");
    await createLead(db, salesA, { followUpAt: new Date(Date.now() - 60_000).toISOString() });
    expect(await claim()).toEqual([]);
    await link(salesA, 1001); // relinking restores delivery
    expect((await one<{ status: string }>(db, "select status from public.telegram_connections where user_id = $1", [salesA])).status).toBe("connected");
  });

  it("bounds batch size", async () => {
    await asUser(db, salesA, async (tx) => {
      for (let i = 0; i < 5; i++) {
        await tx.query("select public.create_lead(p_name => 'Batch', p_phone => $1, p_phone_normalized => $1, p_new_niche => 'Retail', p_follow_up_at => now() - interval '5 minutes')", [`+9180000000${10 + i}`]);
      }
    });
    expect(await claim(2)).toHaveLength(2);
    expect(await claim(100)).toHaveLength(3);
  });
});
