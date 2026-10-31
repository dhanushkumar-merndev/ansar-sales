import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createLead, createUser, one, rows, type Db } from "./harness";

// 20261008005800_whatsapp_channel: WhatsApp next to Telegram, one active channel per person, alerts held
// while the free 24-hour window is closed.

let db: Db;
let admin: string, salesA: string, salesB: string, salesC: string, superAdmin: string;

type Reminder = { delivery_id: string; lease_token: string; chat_id: number | null; channel: string; wa_id: string | null; lead_name: string };
type Note = { notification_id: string; lease_token: string; chat_id: number | null; channel: string; wa_id: string | null; kind: string };
type Inbound = { connected: boolean; linked?: boolean; name?: string; released?: number; code_invalid?: boolean };

const code = (userId: string) => asUser(db, userId, async (tx) => (await one<{ c: string }>(tx, "select public.create_whatsapp_link() as c")).c);
const inbound = (waId: string, c: string | null = null) =>
  asService(db, async (tx) => (await one<{ r: Inbound }>(tx, "select public.whatsapp_inbound($1, $2) as r", [waId, c])).r);
const linkWa = async (userId: string, waId: string) => inbound(waId, await code(userId));
const linkTg = async (userId: string, chatId: number) => {
  const token = await asUser(db, userId, async (tx) => (await one<{ t: string }>(tx, "select public.create_telegram_link_token() as t")).t);
  await asService(db, (tx) => tx.query("select public.consume_telegram_link_token($1, $2, 'tg')", [token, chatId]));
};
const channels = (userId: string) =>
  asUser(db, userId, async (tx) => (await one<{ r: { active: string; whatsapp: null | { status: string; masked: string; window_until: string | null; held: number } } }>(tx,
    "select public.my_notify_channels() as r")).r);
const claimReminders = () => asService(db, (tx) => rows<Reminder>(tx, "select * from public.claim_due_reminders(25, 120)"));
const claimNotes = () => asService(db, (tx) => rows<Note>(tx, "select * from public.claim_due_notifications(25, 120)"));
const finishNote = (n: Note, result: string, external: string | null = null) =>
  asService(db, async (tx) => (await one<{ r: string }>(tx,
    "select public.finish_notification(p_id => $1, p_lease_token => $2, p_result => $3, p_external_id => $4) as r", [n.notification_id, n.lease_token, result, external])).r);
const enqueueTest = (userId: string) => asUser(db, userId, (tx) => tx.query("select public.send_test_notification()"));
const quietWindow = (userId: string, ago: string) =>
  db.query(`update public.whatsapp_connections set last_inbound_at = now() - $2::interval where user_id = $1`, [userId, ago]);

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
  salesC = await createUser(db, "sales.c", "sales", "Sales C");
  superAdmin = await createUser(db, "super", "super_admin", "Super");
});

beforeEach(async () => {
  await db.query("update public.reminder_deliveries set state = 'cancelled' where state in ('pending', 'processing')");
  await db.query("update public.telegram_notifications set state = 'cancelled' where state in ('pending', 'processing')");
});

describe("linking a WhatsApp number", () => {
  it("links with a one-time code sent from the number, and makes WhatsApp the active channel", async () => {
    const c = await code(salesA);
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(c).toMatch(/[0-9]/);
    const stored = await rows<{ code_hash: string }>(db, "select code_hash from public.whatsapp_link_codes where user_id = $1", [salesA]);
    expect(stored.map((s) => s.code_hash)).not.toContain(c);

    expect(await inbound("919800011111", "ZZZZ99")).toMatchObject({ connected: false, code_invalid: true });
    expect(await inbound("919800011111", c.toLowerCase())).toMatchObject({ connected: true, linked: true, name: "Sales A" });
    // Used once.
    expect(await inbound("919800022222", c)).toMatchObject({ connected: false });
    const mine = await channels(salesA);
    expect(mine.active).toBe("whatsapp");
    expect(mine.whatsapp).toMatchObject({ status: "connected", masked: "+91 ••••• 11111", held: 0 });
    expect(mine.whatsapp?.window_until).not.toBeNull();
  });

  it("refuses expired codes and limits how many codes can be made", async () => {
    const c = await code(salesB);
    await db.query("update public.whatsapp_link_codes set expires_at = now() - interval '1 minute' where user_id = $1", [salesB]);
    expect(await inbound("919800033333", c)).toMatchObject({ connected: false });
    // A new code replaces the open one.
    const first = await code(salesB);
    await code(salesB);
    expect(await inbound("919800033333", first)).toMatchObject({ connected: false });
    await code(salesB);
    await code(salesB);
    await expect(code(salesB)).rejects.toThrow(/rate_limited/);
  });

  it("moves a number to whoever sends a fresh code from it", async () => {
    await linkWa(salesC, "919800044444");
    await db.query("delete from public.whatsapp_link_codes where user_id = $1", [salesB]);
    expect(await linkWa(salesB, "919800044444")).toMatchObject({ linked: true, name: "Sales B" });
    expect((await channels(salesC)).whatsapp).toBeNull();
    expect((await channels(salesC)).active).toBe("telegram");
    expect((await channels(salesB)).active).toBe("whatsapp");
  });

  it("keeps the number and link codes private", async () => {
    for (const t of ["whatsapp_connections", "whatsapp_link_codes", "whatsapp_webhook_seen"]) {
      await expect(asUser(db, salesA, (tx) => tx.query(`select * from public.${t}`))).rejects.toThrow(/permission denied/);
    }
    for (const sql of [
      "select public.whatsapp_inbound('919800011111', null)",
      "select * from public.claim_whatsapp_prompts(5, false)",
      "select public.whatsapp_delivery_status('x', 'failed', 131047)",
      "select public.whatsapp_bot_summary('919800011111')",
      "select * from public.claim_due_reminders(5, 60)",
    ]) {
      await expect(asUser(db, salesA, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    }
    await expect(asUser(db, salesA, (tx) => tx.query("select public.super_whatsapp_status()"))).rejects.toThrow();
    const status = await asUser(db, superAdmin, async (tx) => (await one<{ r: { linked: number } }>(tx, "select public.super_whatsapp_status() as r")).r);
    expect(Number(status.linked)).toBeGreaterThan(0);
  });
});

describe("one active channel", () => {
  it("switches on linking, refuses an unlinked channel, and falls back on disconnect", async () => {
    const u = await createUser(db, "sales.switch", "sales", "Switch");
    await expect(asUser(db, u, (tx) => tx.query("select public.set_notify_channel('whatsapp')"))).rejects.toThrow(/channel_not_connected/);
    await linkTg(u, 7001);
    expect((await channels(u)).active).toBe("telegram");
    await linkWa(u, "919800055555");
    expect((await channels(u)).active).toBe("whatsapp");
    await asUser(db, u, (tx) => tx.query("select public.set_notify_channel('telegram')"));
    expect((await channels(u)).active).toBe("telegram");
    await linkTg(u, 7001);
    await asUser(db, u, (tx) => tx.query("select public.set_notify_channel('whatsapp')"));
    // Disconnecting the active one falls back to the other.
    await asUser(db, u, (tx) => tx.query("select public.disconnect_whatsapp()"));
    expect((await channels(u)).active).toBe("telegram");
    await linkWa(u, "919800055555");
    await asUser(db, u, (tx) => tx.query("select public.set_notify_channel('telegram')"));
    await asUser(db, u, (tx) => tx.query("select public.disconnect_telegram()"));
    expect((await channels(u)).active).toBe("whatsapp");
  });

  it("sends each alert only to the active channel", async () => {
    const u = await createUser(db, "sales.route", "sales", "Route");
    await linkTg(u, 7002);
    await linkWa(u, "919800066666");
    await enqueueTest(u);
    let claimed = (await claimNotes()).filter((n) => n.kind === "test");
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ channel: "whatsapp", wa_id: "919800066666", chat_id: null });
    await finishNote(claimed[0], "sent", "wamid.1");

    await asUser(db, u, (tx) => tx.query("select public.set_notify_channel('telegram')"));
    await db.query("update public.telegram_notifications set created_at = now() - interval '1 minute' where recipient_id = $1", [u]);
    await enqueueTest(u);
    claimed = (await claimNotes()).filter((n) => n.kind === "test");
    expect(claimed[0]).toMatchObject({ channel: "telegram", chat_id: 7002, wa_id: null });
  });

  it("queues nothing when the active channel isn't linked", async () => {
    const u = await createUser(db, "sales.none", "sales", "None");
    await expect(enqueueTest(u)).rejects.toThrow(/channel_not_connected/);
  });
});

describe("the free window", () => {
  it("holds alerts while the window is closed, tells the bell once, and sends them when the person writes", async () => {
    const u = await createUser(db, "sales.hold", "sales", "Hold");
    await linkWa(u, "919800077777");
    await quietWindow(u, "25 hours");
    const lead = await createLead(db, u, { name: "Held Lead", followUpAt: new Date(Date.now() - 60_000).toISOString() });

    expect(await claimReminders()).toEqual([]);
    const held = await one<{ state: string; last_error: string; attempts: number; later: boolean }>(db,
      `select d.state, d.last_error, d.attempts, d.next_attempt_at > now() + interval '2 days' as later
       from public.reminder_deliveries d join public.follow_ups f on f.id = d.follow_up_id where f.lead_id = $1`, [lead]);
    expect(held).toEqual({ state: "pending", last_error: "whatsapp_window_closed", attempts: 0, later: true });
    expect((await channels(u)).whatsapp?.held).toBe(1);
    expect((await channels(u)).whatsapp?.window_until).toBeNull();
    const bell = await rows(db, "select 1 from public.app_notifications where recipient_id = $1 and kind = 'whatsapp_paused'", [u]);
    expect(bell).toHaveLength(1);

    // A second held alert in the same closed window doesn't add another bell item.
    await createLead(db, u, { name: "Held Lead 2", followUpAt: new Date(Date.now() - 30_000).toISOString() });
    expect(await claimReminders()).toEqual([]);
    expect(await rows(db, "select 1 from public.app_notifications where recipient_id = $1 and kind = 'whatsapp_paused'", [u])).toHaveLength(1);

    // Any message opens the window and releases them.
    expect(await inbound("919800077777")).toMatchObject({ connected: true, released: 2 });
    const sent = await claimReminders();
    expect(sent.map((r) => r.lead_name).sort()).toEqual(["Held Lead", "Held Lead 2"]);
    expect(sent.every((r) => r.channel === "whatsapp" && r.wa_id === "919800077777")).toBe(true);
  });

  it("drops what was held for 3 days without a reply", async () => {
    const u = await createUser(db, "sales.expire", "sales", "Expire");
    await linkWa(u, "919800088888");
    await quietWindow(u, "30 hours");
    const lead = await createLead(db, u, { followUpAt: new Date(Date.now() - 60_000).toISOString() });
    await claimReminders();
    await db.query(`update public.reminder_deliveries d set next_attempt_at = now() - interval '1 minute'
      from public.follow_ups f where f.id = d.follow_up_id and f.lead_id = $1`, [lead]);
    await claimReminders();
    const row = await one<{ state: string; last_error: string }>(db,
      "select d.state, d.last_error from public.reminder_deliveries d join public.follow_ups f on f.id = d.follow_up_id where f.lead_id = $1", [lead]);
    expect(row).toEqual({ state: "skipped", last_error: "whatsapp_window_expired" });
  });

  it("puts an alert back on hold when WhatsApp reports the window had closed, and marks undeliverable numbers", async () => {
    const u = await createUser(db, "sales.status", "sales", "Status");
    await linkWa(u, "919800099999");
    await enqueueTest(u);
    const [n] = (await claimNotes()).filter((x) => x.kind === "test");
    await finishNote(n, "sent", "wamid.status1");
    const r = await asService(db, async (tx) => (await one<{ r: string }>(tx, "select public.whatsapp_delivery_status('wamid.status1', 'failed', 131047) as r")).r);
    expect(r).toBe("held");
    expect(await one(db, "select state, last_error from public.telegram_notifications where id = $1", [n.notification_id]))
      .toEqual({ state: "pending", last_error: "whatsapp_window_closed" });
    expect((await channels(u)).whatsapp?.window_until).toBeNull();

    await inbound("919800099999");
    const [again] = (await claimNotes()).filter((x) => x.kind === "test");
    await finishNote(again, "sent", "wamid.status2");
    expect(await asService(db, async (tx) => (await one<{ r: string }>(tx, "select public.whatsapp_delivery_status('wamid.status2', 'delivered', null) as r")).r)).toBe("ignored");
    expect(await asService(db, async (tx) => (await one<{ r: string }>(tx, "select public.whatsapp_delivery_status('wamid.status2', 'failed', 131026) as r")).r)).toBe("blocked");
    expect((await channels(u)).whatsapp?.status).toBe("blocked");
    // Writing again means they can receive.
    await inbound("919800099999");
    expect((await channels(u)).whatsapp?.status).toBe("connected");
  });

  it("'hold' from the worker keeps the alert without counting an attempt", async () => {
    const u = await createUser(db, "sales.hold2", "sales", "Hold 2");
    await linkWa(u, "919800012121");
    await enqueueTest(u);
    const [n] = (await claimNotes()).filter((x) => x.kind === "test");
    expect(await finishNote(n, "hold")).toBe("pending");
    expect(await one(db, "select state, attempts, last_error from public.telegram_notifications where id = $1", [n.notification_id]))
      .toEqual({ state: "pending", attempts: 0, last_error: "whatsapp_window_closed" });
  });

  it("nudges once per window in the last 2 hours, only in the daytime, and the evening before an overnight close", async () => {
    const u = await createUser(db, "sales.nudge", "sales", "Nudge");
    await linkWa(u, "919800013131");
    // Times in IST, so the test doesn't depend on the clock.
    const at = (ist: string) => new Date(`${ist}+05:30`).toISOString();
    const lastMessage = (iso: string) => db.query("update public.whatsapp_connections set last_inbound_at = $2, nudged_at = null where user_id = $1", [u, iso]);
    const prompts = (now: string) => asService(db, (tx) => rows<{ user_id: string; kind: string; window_until: string; upcoming: number }>(tx,
      "select * from public.claim_whatsapp_prompts(25, true, $1)", [now])).then((r) => r.filter((p) => p.user_id === u));

    // Last message 15:00 → the window closes 14:55 the next day.
    await lastMessage(at("2026-11-02T15:00:00"));
    expect(await prompts(at("2026-11-03T12:00:00"))).toEqual([]); // 3 hours before: too early
    const [n] = await prompts(at("2026-11-03T13:00:00"));
    expect(n).toMatchObject({ kind: "nudge", upcoming: 0 });
    expect(new Date(n.window_until).toISOString()).toBe(at("2026-11-03T14:55:00"));
    expect(await prompts(at("2026-11-03T13:30:00"))).toEqual([]); // once per window
    // A reply starts a new window and a new nudge.
    await lastMessage(at("2026-11-03T13:30:00"));
    expect(await prompts(at("2026-11-04T11:40:00"))).toMatchObject([{ kind: "nudge" }]);

    // Closes at 02:55: nobody is asked at night, so the nudge comes the evening before.
    await lastMessage(at("2026-11-04T03:00:00"));
    expect(await prompts(at("2026-11-05T01:00:00"))).toEqual([]);
    expect(await prompts(at("2026-11-04T19:59:00"))).toEqual([]);
    expect(await prompts(at("2026-11-04T20:00:00"))).toMatchObject([{ kind: "nudge" }]);
  });

  it("drops event alerts that are more than 6 hours late instead of sending a flood", async () => {
    const u = await createUser(db, "sales.stale", "sales", "Stale");
    await linkWa(u, "919800016161");
    await enqueueTest(u);
    const id = (await one<{ id: string }>(db, "select id from public.telegram_notifications where recipient_id = $1 order by created_at desc limit 1", [u])).id;
    await db.query("update public.telegram_notifications set next_attempt_at = now() - interval '7 hours' where id = $1", [id]);
    await db.query("select private.expire_stale_alerts()");
    expect(await one(db, "select state, last_error from public.telegram_notifications where id = $1", [id])).toEqual({ state: "skipped", last_error: "stale" });
  });

  it("wakes the worker when an alert is queued, at most once every 2 seconds", async () => {
    const u = await createUser(db, "sales.kick", "sales", "Kick");
    await linkWa(u, "919800017171");
    await db.query("update private.worker_kick set last_at = '-infinity'");
    await enqueueTest(u);
    const first = (await one<{ last_at: Date }>(db, "select last_at from private.worker_kick")).last_at;
    expect(Date.now() - new Date(first).getTime()).toBeLessThan(60_000);
    await db.query("insert into public.telegram_notifications (recipient_id, kind, payload, dedupe_key) values ($1, 'test', '{}', 'kick-2')", [u]);
    expect((await one<{ last_at: Date }>(db, "select last_at from private.worker_kick")).last_at).toEqual(first);
  });

  it("offers the paid reopen message only when asked, once per closed window with alerts waiting", async () => {
    const u = await createUser(db, "sales.reopen", "sales", "Reopen");
    await linkWa(u, "919800014141");
    await quietWindow(u, "26 hours");
    const prompts = (reopen: boolean) => asService(db, (tx) => rows<{ user_id: string; kind: string; held: number }>(tx,
      "select * from public.claim_whatsapp_prompts(25, $1)", [reopen]));
    expect((await prompts(true)).filter((p) => p.user_id === u)).toEqual([]); // nothing waiting
    await enqueueTest(u);
    await claimNotes(); // held
    expect((await prompts(false)).filter((p) => p.user_id === u)).toEqual([]);
    expect((await prompts(true)).filter((p) => p.user_id === u)).toMatchObject([{ kind: "reopen", held: 1 }]);
    expect((await prompts(true)).filter((p) => p.user_id === u)).toEqual([]);
  });

  it("switching to Telegram sends held alerts there at once", async () => {
    const u = await createUser(db, "sales.flip", "sales", "Flip");
    await linkTg(u, 7003);
    await linkWa(u, "919800015151");
    await quietWindow(u, "26 hours");
    await enqueueTest(u);
    expect((await claimNotes()).filter((x) => x.kind === "test")).toEqual([]);
    await asUser(db, u, (tx) => tx.query("select public.set_notify_channel('telegram')"));
    expect((await claimNotes()).filter((x) => x.kind === "test")).toMatchObject([{ channel: "telegram", chat_id: 7003 }]);
  });
});

describe("bot actions from WhatsApp", () => {
  it("shows the same summary as Telegram and silences only the assignee's overdue alerts", async () => {
    await linkWa(admin, "919800016161");
    const summary = await asService(db, async (tx) => (await one<{ r: { connected: boolean; name: string } }>(tx,
      "select public.whatsapp_bot_summary('919800016161') as r")).r);
    expect(summary).toMatchObject({ connected: true, name: "Admin" });
    expect(await asService(db, async (tx) => (await one<{ r: { connected: boolean } }>(tx, "select public.whatsapp_bot_summary('911111111111') as r")).r))
      .toEqual({ connected: false });

    const lead = await createLead(db, salesA, { followUpAt: new Date(Date.now() - 60_000).toISOString() });
    const fu = await one<{ id: string }>(db, "select id from public.follow_ups where lead_id = $1", [lead]);
    const silence = (wa: string) => asService(db, async (tx) => (await one<{ r: { ok: boolean } }>(tx,
      "select public.whatsapp_silence_nag($1, $2) as r", [wa, fu.id])).r);
    expect((await silence("919800016161")).ok).toBe(false); // admin isn't the assignee
    expect((await silence("919800011111")).ok).toBe(true); // Sales A's number
    expect(await rows(db, "select 1 from public.follow_up_nag_silences where follow_up_id = $1", [fu.id])).toHaveLength(1);
  });
});
