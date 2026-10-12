import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createLead, createUser, one, rows, type Db } from "./harness";

// The bell: every alert also lands in app_notifications, whether or not the person connected Telegram,
// with its own on/off switch per kind; and the Projects page's shared folder colours.

let db: Db;
let admin: string, salesA: string, salesB: string, offline: string;

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
  offline = await createUser(db, "sales.offline", "sales", "No Telegram");
  await db.query("insert into public.telegram_connections (user_id, chat_id) values ($1, 111), ($2, 222), ($3, 333)", [admin, salesA, salesB]);
});

type Item = { id: string; kind: string; payload: Record<string, unknown>; read_at: string | null };
type Mine = { items: Item[]; total: number; unread: number };
const mine = (uid: string, unread = false, limit = 20, offset = 0) =>
  asUser(db, uid, async (tx) => (await one<{ r: Mine }>(tx, "select public.my_notifications($1, $2, $3) as r", [unread, limit, offset])).r);
const telegram = (uid: string, kind: string) =>
  rows(db, "select 1 from public.telegram_notifications where recipient_id = $1 and kind = $2", [uid, kind]).then((r) => r.length);

describe("in-app notifications", () => {
  it("reach people without Telegram, never the actor, and say what happened", async () => {
    const lead = await createLead(db, admin, { name: "Bell lead", ownerId: offline });
    const off = await mine(offline);
    expect(off.items.map((i) => [i.kind, i.payload.lead_name])).toEqual([["lead_assigned", "Bell lead"]]);
    expect(off.unread).toBe(1);
    expect(await telegram(offline, "lead_assigned")).toBe(0); // no Telegram: in the app only
    expect((await mine(admin)).items.filter((i) => i.payload.lead_id === lead)).toEqual([]); // the actor
  });

  it("has separate switches for the bell and Telegram", async () => {
    await asUser(db, salesB, (tx) => tx.query("select public.set_notification_pref('lead_assigned', false, 'app')"));
    await createLead(db, admin, { name: "Muted in app", ownerId: salesB });
    expect((await mine(salesB)).items.some((i) => i.payload.lead_name === "Muted in app")).toBe(false);
    expect(await telegram(salesB, "lead_assigned")).toBe(1); // Telegram still on

    await asUser(db, salesB, async (tx) => {
      await tx.query("select public.set_notification_pref('lead_assigned', true, 'app')");
      await tx.query("select public.set_notification_pref('lead_assigned', false)"); // the old call: Telegram
    });
    await createLead(db, admin, { name: "Bell only", ownerId: salesB });
    expect((await mine(salesB)).items.some((i) => i.payload.lead_name === "Bell only")).toBe(true);
    expect(await telegram(salesB, "lead_assigned")).toBe(1); // no second Telegram message
    await expect(asUser(db, salesB, (tx) => tx.query("select public.set_notification_pref('lead_assigned', false, 'email')"))).rejects.toThrow(/invalid_kind/);
  });

  it("files a repeating overdue alert once per follow-up", async () => {
    const lead = await createLead(db, offline, { name: "Late one" });
    const fu = await asUser(db, offline, async (tx) => (await one<{ id: string }>(tx,
      "insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, 'Call', now() - interval '1 day', $2) returning id", [lead, offline])).id);
    for (const bucket of ["a", "b", "c"]) {
      await db.query("select private.enqueue_notification($1, 'overdue_nag', $2::jsonb, $3, null, $4, $5)",
        [offline, JSON.stringify({ lead_id: lead, lead_name: "Late one", follow_up_id: fu, revision: 1, task: "Call", due_at: new Date().toISOString() }), `overdue:${fu}:1:${bucket}`, lead, fu]);
    }
    expect((await mine(offline)).items.filter((i) => i.kind === "overdue_nag")).toHaveLength(1);
  });

  it("pages, counts, and marks read — only your own", async () => {
    for (let i = 0; i < 3; i++) await createLead(db, admin, { name: `Page ${i}`, ownerId: salesA });
    const all = await mine(salesA, false, 2, 0);
    expect(all.items).toHaveLength(2);
    expect(all.total).toBe(3);
    expect(all.items[0].payload.lead_name).toBe("Page 2"); // newest first

    // Someone else can neither see nor mark them.
    await asUser(db, salesB, (tx) => tx.query("select public.mark_notifications_read($1)", [[all.items[0].id]]));
    expect((await mine(salesA)).unread).toBe(3);
    expect(await asUser(db, salesB, (tx) => rows(tx, "select id from public.app_notifications where id = $1", [all.items[0].id]))).toEqual([]);

    const left = await asUser(db, salesA, async (tx) => (await one<{ n: number }>(tx, "select public.mark_notifications_read($1) as n", [[all.items[0].id]])).n);
    expect(left).toBe(2);
    expect((await mine(salesA, true)).items.map((i) => i.payload.lead_name)).toEqual(["Page 1", "Page 0"]);
    await asUser(db, salesA, (tx) => tx.query("select public.mark_notifications_read()"));
    expect((await mine(salesA)).unread).toBe(0);
    // Only read_at can change.
    await expect(asUser(db, salesA, (tx) => tx.query("update public.app_notifications set kind = 'x' where recipient_id = $1", [salesA]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, salesA, (tx) => tx.query("select public.my_notifications(false, 101)"))).rejects.toThrow(/invalid_page/);
  });

  it("cleans up old items", async () => {
    await db.query("update public.app_notifications set created_at = now() - interval '61 days' where recipient_id = $1", [salesA]);
    await db.query("select private.cleanup_app_notifications()");
    expect((await mine(salesA)).total).toBe(0); // read and older than 60 days
    expect((await mine(offline)).total).toBeGreaterThan(0); // recent ones stay
  });
});

describe("project folder colours", () => {
  it("are shared in the company and set only by admins and architect managers", async () => {
    const gardens = await createCompany(db, "Star Gardens");
    await db.query("update public.companies set features = array['projects'] where id = $1", [gardens]);
    const gAdmin = await createUser(db, "fc_admin", "admin", "G Admin", gardens);
    const manager = await createUser(db, "fc_am", "architect_manager" as never, "Raj", gardens);
    const designer = await createUser(db, "fc_ld", "landscape_designer" as never, "Diny", gardens);
    const colors = (uid: string) => asUser(db, uid, (tx) => rows<{ year: number; month: number | null; color: string }>(tx,
      "select year, month, color from public.project_folder_colors order by year, month nulls first"));

    await asUser(db, manager, (tx) => tx.query("select public.set_project_folder_color(2026, 10, 'pink')"));
    await asUser(db, gAdmin, (tx) => tx.query("select public.set_project_folder_color(2026, null, 'emerald')"));
    await asUser(db, gAdmin, (tx) => tx.query("select public.set_project_folder_color(2026, 10, 'violet')")); // replaces
    expect(await colors(designer)).toEqual([{ year: 2026, month: null, color: "emerald" }, { year: 2026, month: 10, color: "violet" }]);
    await expect(asUser(db, designer, (tx) => tx.query("select public.set_project_folder_color(2026, 9, 'sky')"))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, manager, (tx) => tx.query("select public.set_project_folder_color(2026, 13, 'sky')"))).rejects.toThrow(/invalid_input/);
    await asUser(db, manager, (tx) => tx.query("select public.set_project_folder_color(2026, 10, null)")); // back to the default
    expect((await colors(designer)).map((c) => c.month)).toEqual([null]);
    // Another company sees none of them.
    expect(await colors(admin)).toEqual([]);
  });
});
