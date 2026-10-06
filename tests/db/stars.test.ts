import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createLead, createUser, one, rows, type Db } from "./harness";

let db: Db;
let admin: string, salesA: string, salesB: string, account: string;

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
  account = await createUser(db, "account", "account", "Account");
});

type Star = { starred: boolean; pinned_at: string | null };
type Page = { items: { id: string; starred: boolean; pinned_at: string | null }[]; total: number; pinned_count: number };

const star = (user: string, leadId: string, on = true) =>
  asUser(db, user, async (tx) => (await one<{ r: Star }>(tx, "select public.set_lead_star($1, $2) as r", [leadId, on])).r);
const pin = (user: string, leadId: string, on = true) =>
  asUser(db, user, async (tx) => (await one<{ r: Star }>(tx, "select public.set_lead_pin($1, $2) as r", [leadId, on])).r);
const starred = (user: string, sort = "name", dir = "asc") =>
  asUser(db, user, async (tx) => (await one<{ r: Page }>(tx,
    "select public.list_leads(p_sort => $1, p_dir => $2, p_limit => 100, p_starred_only => true) as r", [sort, dir])).r);

describe("lead stars", () => {
  it("are personal: other users never see them", async () => {
    const a = await createLead(db, salesA, { name: "Personal" });
    await star(salesA, a);
    await star(admin, a);
    expect((await starred(salesA)).items.map((i) => i.id)).toContain(a);
    const aStars = await asUser(db, salesA, (tx) => rows(tx, "select * from public.lead_stars"));
    expect(aStars).toHaveLength(1); // admin's star on the same lead is invisible to Sales A
    const all = await asUser(db, salesA, async (tx) => (await one<{ r: Page }>(tx, "select public.list_leads(p_limit => 100) as r")).r);
    expect(all.items.find((i) => i.id === a)?.starred).toBe(true);
  });

  it("cannot be set on a lead the user cannot access, or by Account", async () => {
    const a = await createLead(db, salesA, { name: "Private" });
    await expect(star(salesB, a)).rejects.toThrow(/not_found/);
    await expect(asUser(db, salesB, (tx) => tx.query("insert into public.lead_stars (lead_id) values ($1)", [a]))).rejects.toThrow();
    await expect(star(account, a)).rejects.toThrow(/not_found/);
    await expect(asUser(db, salesB, (tx) => tx.query("insert into public.lead_stars (user_id, lead_id) values ($1, $2)", [salesA, a]))).rejects.toThrow();
  });

  it("pinning stars the lead and unstarring removes the pin", async () => {
    const a = await createLead(db, salesB, { name: "PinStar" });
    expect((await pin(salesB, a)).starred).toBe(true);
    expect((await star(salesB, a, false))).toEqual({ starred: false, pinned_at: null });
    expect((await starred(salesB)).items.map((i) => i.id)).not.toContain(a);
  });

  it("lists pinned leads first, latest pin on top, then the rest in the chosen sort", async () => {
    const user = await createUser(db, "sales.order", "sales", "Order");
    const ids: Record<string, string> = {};
    for (const n of ["Alpha", "Bravo", "Charlie", "Delta"]) {
      ids[n] = await createLead(db, user, { name: n });
      await star(user, ids[n]);
    }
    await pin(user, ids.Charlie);
    await new Promise((r) => setTimeout(r, 5));
    await pin(user, ids.Bravo);
    const page = await starred(user, "name", "asc");
    expect(page.items.map((i) => i.id)).toEqual([ids.Bravo, ids.Charlie, ids.Alpha, ids.Delta]);
    expect(page.total).toBe(4);
    expect(page.pinned_count).toBe(2);
  });

  it("allows at most 10 pins; unpinning frees a slot", async () => {
    const user = await createUser(db, "sales.limit", "sales", "Limit");
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push(await createLead(db, user, { name: `Limit ${i}` }));
    for (const id of ids.slice(0, 10)) await pin(user, id);
    await expect(pin(user, ids[10])).rejects.toThrow(/pin_limit/);
    expect(await pin(user, ids[0])).toMatchObject({ starred: true }); // re-pinning an existing pin is fine
    await pin(user, ids[0], false);
    expect((await pin(user, ids[10])).pinned_at).not.toBeNull();
    // Direct table writes hit the same limit.
    await expect(asUser(db, user, (tx) => tx.query("update public.lead_stars set pinned_at = now() where lead_id = $1", [ids[0]]))).rejects.toThrow(/pin_limit/);
  });

  it("drops the former owner's star on reassignment and everyone's on archive", async () => {
    const a = await createLead(db, salesA, { name: "Moving" });
    await pin(salesA, a);
    await pin(admin, a);
    await asUser(db, admin, (tx) => tx.query("update public.leads set owner_id = $2 where id = $1", [a, salesB]));
    expect((await one<{ n: number }>(db, "select count(*)::int as n from public.lead_stars where lead_id = $1 and user_id = $2", [a, salesA])).n).toBe(0);
    expect((await one<{ n: number }>(db, "select count(*)::int as n from public.lead_stars where lead_id = $1 and user_id = $2", [a, admin])).n).toBe(1);
    await asUser(db, admin, (tx) => tx.query("update public.leads set archived_at = now() where id = $1", [a]));
    expect((await one<{ n: number }>(db, "select count(*)::int as n from public.lead_stars where lead_id = $1", [a])).n).toBe(0);
  });
});

describe("follow-up stars", () => {
  it("shows starred tasks in the 'starred' view, pinned first, and keeps them private", async () => {
    const user = await createUser(db, "sales.fu", "sales", "FU");
    const lead = await createLead(db, user, { name: "Tasks" });
    const fu = await asUser(db, user, async (tx) => {
      for (const due of ["2099-01-03T04:30:00Z", "2099-01-01T04:30:00Z", "2099-01-02T04:30:00Z"]) {
        await tx.query("insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, 'Call', $2, $3)", [lead, due, user]);
      }
      return rows<{ id: string; due_at: string }>(tx, "select id, due_at from public.follow_ups where lead_id = $1 order by due_at", [lead]);
    });
    const [first, second, third] = fu.map((f) => f.id);
    await asUser(db, user, async (tx) => {
      await tx.query("select public.set_follow_up_star($1, true)", [first]);
      await tx.query("select public.set_follow_up_star($1, true)", [second]);
      await tx.query("select public.set_follow_up_pin($1, true)", [third]);
    });
    const page = await asUser(db, user, async (tx) => (await one<{ r: Page }>(tx, "select public.list_follow_ups('starred', null, null, 20, 0) as r")).r);
    expect(page.items.map((i) => i.id)).toEqual([third, first, second]);
    expect(page.pinned_count).toBe(1);
    await expect(asUser(db, salesB, (tx) => tx.query("select public.set_follow_up_star($1, true)", [first]))).rejects.toThrow(/not_found/);
    const other = await asUser(db, salesB, async (tx) => (await one<{ r: Page }>(tx, "select public.list_follow_ups('starred', null, null, 20, 0) as r")).r);
    expect(other.items.map((i) => i.id)).not.toContain(first);
  });
});
