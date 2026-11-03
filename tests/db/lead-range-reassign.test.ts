import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createLead, createUser, rows, type Db } from "./harness";

// 20261008006100_lead_range_reassign: reassign Sl No a..b of the Leads list (the rows lead_range_summary counts)
// to one owner. Preview first (changes nothing, returns a fingerprint), then apply with that fingerprint.

type Preview = {
  from: number; to: number; count: number; fingerprint: string; moving: number; already_owned: number;
  by_owner: { id: string; display_name: string; count: number }[];
};
type Done = { count: number; moved: number };
type Page = { items: { id: string; owner: { id: string } }[] };

let db: Db;
let admin: string, salesA: string, salesB: string, salesC: string, account: string;

async function call<T>(fn: string, userId: string | null, args: Record<string, unknown>) {
  const keys = Object.keys(args);
  const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
  return asUser(db, userId, async (tx) => (await tx.query<{ r: T }>(`select public.${fn}(${named}) as r`, Object.values(args))).rows[0].r);
}

const preview = (userId: string | null, filters: Record<string, unknown>, from: number, to: number, owner: string) =>
  call<Preview>("reassign_lead_range", userId, { ...filters, p_from: from, p_to: to, p_new_owner_id: owner });
const apply = (userId: string | null, filters: Record<string, unknown>, from: number, to: number, owner: string, fingerprint: string) =>
  call<Done>("reassign_lead_range", userId, { ...filters, p_from: from, p_to: to, p_new_owner_id: owner, p_fingerprint: fingerprint });

/** The ids under Sl No a..b, read from list_leads (the way the screen numbers them). */
async function idsAt(userId: string, filters: Record<string, unknown>, a: number, b: number) {
  const page = await call<Page>("list_leads", userId, { ...filters, p_limit: 100, p_offset: a - 1 });
  return page.items.slice(0, b - a + 1).map((i) => i.id);
}

const owners = async () => new Map((await rows<{ id: string; owner_id: string }>(db, "select id, owner_id from public.leads")).map((r) => [r.id, r.owner_id]));

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
  salesC = await createUser(db, "sales.c", "sales", "Sales C");
  account = await createUser(db, "account", "account", "Account");
  const soon = new Date(Date.now() + 86_400_000).toISOString();
  for (let i = 0; i < 30; i++) await createLead(db, salesA, { name: `A ${String(i).padStart(2, "0")}`, followUpAt: i % 3 ? undefined : soon });
  for (let i = 0; i < 20; i++) await createLead(db, salesB, { name: `B ${String(i).padStart(2, "0")}`, followUpAt: i % 2 ? soon : undefined });
}, 120_000);

describe("reassign_lead_range", () => {
  it("previews the rows the list shows under those Sl Nos without changing anything", async () => {
    const f = { p_sort: "name", p_dir: "asc" };
    const before = await owners();
    const p = await preview(admin, f, 25, 40, salesC);
    expect(p).toMatchObject({ from: 25, to: 40, count: 16, moving: 16, already_owned: 0 });
    expect(p.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    // Names sort A 00..A 29 then B 00..B 19: rows 25-30 are Sales A's, 31-40 Sales B's.
    expect(p.by_owner).toEqual([
      { id: salesB, display_name: "Sales B", count: 10 },
      { id: salesA, display_name: "Sales A", count: 6 },
    ]);
    expect(await owners()).toEqual(before);
    // Same count as the summary popover.
    const s = await call<{ count: number }>("lead_range_summary", admin, { ...f, p_from: 25, p_to: 40 });
    expect(s.count).toBe(p.count);
  });

  it("moves exactly those rows, with their timeline entry and pending follow-ups", async () => {
    const f = { p_sort: "name", p_dir: "asc" };
    const target = await idsAt(admin, f, 25, 40);
    const before = await owners();
    const p = await preview(admin, f, 25, 40, salesC);
    const done = await apply(admin, f, 25, 40, salesC, p.fingerprint);
    expect(done).toMatchObject({ count: 16, moved: 16 });

    const after = await owners();
    for (const [id, owner] of after) expect(owner, id).toBe(target.includes(id) ? salesC : before.get(id));

    const assigned = await rows<{ lead_id: string; n: number }>(db,
      "select lead_id, count(*)::int as n from public.lead_activities where type = 'assigned' group by lead_id");
    expect(assigned.map((a) => a.lead_id).sort()).toEqual([...target].sort());
    expect(assigned.every((a) => a.n === 1)).toBe(true);

    const pending = await rows<{ lead_id: string; assignee_id: string }>(db,
      "select lead_id, assignee_id from public.follow_ups where state = 'pending'");
    expect(pending.length).toBeGreaterThan(0);
    for (const f2 of pending) expect(f2.assignee_id).toBe(after.get(f2.lead_id));

    // Sales C now sees them; their previous owners don't.
    expect((await call<{ count: number }>("lead_range_summary", salesC, { p_from: 1, p_to: 1000 })).count).toBe(16);
    expect((await call<{ count: number }>("lead_range_summary", salesA, { p_from: 1, p_to: 1000 })).count).toBe(24);
    expect((await call<{ count: number }>("lead_range_summary", salesB, { p_from: 1, p_to: 1000 })).count).toBe(10);
  });

  it("skips leads the new owner already has", async () => {
    const f = { p_owner_id: salesC, p_sort: "name", p_dir: "asc" };
    const p = await preview(admin, f, 1, 5, salesC);
    expect(p).toMatchObject({ count: 5, moving: 0, already_owned: 5, by_owner: [] });
    expect(await apply(admin, f, 1, 5, salesC, p.fingerprint)).toMatchObject({ moved: 0 });
  });

  it("refuses when the range no longer holds the previewed leads", async () => {
    const f = { p_sort: "name", p_dir: "asc" };
    const p = await preview(admin, f, 1, 10, salesB);
    // "0 first" sorts before "A 00" and shifts every Sl No by one.
    await createLead(db, salesA, { name: "0 first" });
    const before = await owners();
    await expect(apply(admin, f, 1, 10, salesB, p.fingerprint)).rejects.toThrow(/range_changed/);
    expect(await owners()).toEqual(before);
    const again = await preview(admin, f, 1, 10, salesB);
    expect(again.fingerprint).not.toBe(p.fingerprint);
    expect((await apply(admin, f, 1, 10, salesB, again.fingerprint)).moved).toBe(10);
  });

  it("is admin only and checks the range, view and new owner", async () => {
    for (const user of [salesA, account, null]) {
      await expect(preview(user, {}, 1, 5, salesB)).rejects.toThrow(/forbidden|permission denied/);
    }
    // Sales can't apply either, even with a valid fingerprint.
    const p = await preview(admin, {}, 1, 5, salesB);
    await expect(apply(salesA, {}, 1, 5, salesB, p.fingerprint)).rejects.toThrow(/forbidden/);

    await expect(preview(admin, {}, 1, 1000, salesB)).resolves.toMatchObject({ to: 1000 });
    await expect(preview(admin, {}, 1, 1001, salesB)).rejects.toThrow(/reassign_range_too_large/);
    for (const [a, b] of [[0, 5], [5, 4]]) await expect(preview(admin, {}, a, b, salesB)).rejects.toThrow(/invalid_sl_range/);
    await expect(preview(admin, { p_archived: true }, 1, 5, salesB)).rejects.toThrow(/forbidden/);
    await expect(preview(admin, {}, 1, 5, account)).rejects.toThrow(/invalid_owner/);

    await db.query("update public.profiles set is_active = false where id = $1", [salesC]);
    await expect(preview(admin, {}, 1, 5, salesC)).rejects.toThrow(/invalid_owner/);
  });
});
