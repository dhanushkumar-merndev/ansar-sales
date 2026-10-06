import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createUser, nextPhone, type Db } from "./harness";

type Page = { items: { id: string; name: string; status: string; overdue: boolean }[]; total: number };

let db: Db;
let admin: string, salesA: string, salesB: string;

async function list(userId: string, args: Record<string, unknown> = {}): Promise<Page> {
  const keys = Object.keys(args);
  const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
  return asUser(db, userId, async (tx) =>
    (await tx.query<{ r: Page }>(`select public.list_leads(${named}) as r`, Object.values(args))).rows[0].r);
}

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin");
  salesA = await createUser(db, "sales.a", "sales");
  salesB = await createUser(db, "sales.b", "sales");
  // 45 leads created in ONE transaction share the same created_at, exercising the id tie-breaker.
  await asUser(db, salesA, async (tx) => {
    for (let i = 0; i < 45; i++) {
      await tx.query(
        `select public.create_lead(p_name => $1, p_phone => $2, p_phone_normalized => $2, p_new_niche => $3, p_status => $4::public.lead_status)`,
        [`Lead ${String(i).padStart(2, "0")}${i === 7 ? " 100%_off" : ""}`, nextPhone(), i % 3 === 0 ? "Retail" : "Healthcare", i % 2 === 0 ? "new" : "contacted"],
      );
    }
  });
  await asUser(db, salesB, (tx) => tx.query(
    `select public.create_lead(p_name => 'Other team lead', p_phone => $1, p_phone_normalized => $1, p_new_niche => 'Retail', p_follow_up_at => now() - interval '1 hour')`, [nextPhone()]));
});

describe("list_leads pagination", () => {
  it("pages through tied timestamps without gaps or duplicates", async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await list(salesA, { p_limit: 20, p_offset: (page - 1) * 20 });
      expect(r.total).toBe(45);
      expect(r.items.length).toBe(page < 3 ? 20 : 5);
      seen.push(...r.items.map((i) => i.id));
    }
    expect(new Set(seen).size).toBe(45);
    expect(seen).toEqual([...seen].sort().reverse()); // created_at tie → id desc
    const beyond = await list(salesA, { p_limit: 20, p_offset: 60 });
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(45);
  });

  it("applies filters before pagination and counts with the same predicates", async () => {
    const r1 = await list(salesA, { p_statuses: "{new}", p_limit: 10, p_offset: 0 });
    const r2 = await list(salesA, { p_statuses: "{new}", p_limit: 10, p_offset: 10 });
    const r3 = await list(salesA, { p_statuses: "{new}", p_limit: 10, p_offset: 20 });
    expect(r1.total).toBe(23);
    expect([...r1.items, ...r2.items, ...r3.items].every((i) => i.status === "new")).toBe(true);
    expect(r1.items.length + r2.items.length + r3.items.length).toBe(23);
    const sortedByName = await list(salesA, { p_sort: "name", p_dir: "asc", p_limit: 5 });
    expect(sortedByName.items.map((i) => i.name)).toEqual(["Lead 00", "Lead 01", "Lead 02", "Lead 03", "Lead 04"]);
  });

  it("treats search input literally and matches normalized phone digits", async () => {
    // Only the lead whose name literally contains % or _ matches (no wildcard expansion).
    expect((await list(salesA, { p_search: "%" })).total).toBe(1);
    expect((await list(salesA, { p_search: "_" })).total).toBe(1);
    expect((await list(salesA, { p_search: "Lead%0" })).total).toBe(0);
    expect((await list(salesA, { p_search: "100%_off" })).total).toBe(1);
    expect((await list(salesA, { p_search: "lead 1" })).total).toBe(10);
    expect((await list(salesA, { p_search: "') or true --" })).total).toBe(0);
  });

  it("keeps sales scope even when an owner filter is supplied", async () => {
    expect((await list(salesB, {})).total).toBe(1);
    expect((await list(salesB, { p_owner_id: salesA })).total).toBe(1);
    expect((await list(admin, { p_owner_id: salesA })).total).toBe(45);
    expect((await list(admin, {})).total).toBe(46);
    const overdue = await list(admin, { p_overdue_only: true });
    expect(overdue.total).toBe(1);
    expect(overdue.items[0].overdue).toBe(true);
  });

  it("rejects invalid paging and sort input", async () => {
    await expect(list(salesA, { p_limit: 101 })).rejects.toThrow(/invalid_limit/);
    await expect(list(salesA, { p_limit: 0 })).rejects.toThrow(/invalid_limit/);
    await expect(list(salesA, { p_offset: -1 })).rejects.toThrow(/invalid_offset/);
    await expect(list(salesA, { p_sort: "name; drop table leads" })).rejects.toThrow(/invalid_sort/);
    await expect(list(salesA, { p_dir: "sideways" })).rejects.toThrow(/invalid_sort/);
    await expect(list(salesA, { p_search: "x".repeat(101) })).rejects.toThrow(/search_too_long/);
  });
});

describe("list_follow_ups", () => {
  it("returns overdue tasks only within scope with a bounded page", async () => {
    const r = await asUser(db, salesB, async (tx) =>
      (await tx.query<{ r: { items: { overdue: boolean; lead: { name: string } }[]; total: number } }>(
        "select public.list_follow_ups('overdue', null, null, 20, 0) as r")).rows[0].r);
    expect(r.total).toBe(1);
    expect(r.items[0]).toMatchObject({ overdue: true, lead: { name: "Other team lead" } });
    const a = await asUser(db, salesA, async (tx) =>
      (await tx.query<{ r: { total: number } }>("select public.list_follow_ups('overdue', null, null, 20, 0) as r")).rows[0].r);
    expect(a.total).toBe(0);
  });

  it("narrows any view to a half-open due-date range", async () => {
    const total = (from: string, to: string) => asUser(db, salesB, async (tx) =>
      (await tx.query<{ r: { total: number } }>(
        "select public.list_follow_ups('overdue', null, null, 20, 0, $1::timestamptz, $2::timestamptz) as r", [from, to])).rows[0].r.total);
    expect(await total("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")).toBe(1);
    expect(await total("2099-01-01T00:00:00Z", "2100-01-01T00:00:00Z")).toBe(0);
    await expect(total("2100-01-01T00:00:00Z", "2000-01-01T00:00:00Z")).rejects.toThrow(/invalid_range/);
  });
});
