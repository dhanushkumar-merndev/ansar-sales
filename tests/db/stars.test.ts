import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createLead, createUser, one, rows, stageId, type Db } from "./harness";

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

  it("keeps star and pin separate: a pin doesn't star, unstarring keeps the pin", async () => {
    const a = await createLead(db, salesB, { name: "PinStar" });
    expect(await pin(salesB, a)).toMatchObject({ starred: false });
    expect((await starred(salesB)).items.map((i) => i.id)).not.toContain(a); // pinned only: not in Starred
    expect((await star(salesB, a)).starred).toBe(true);
    const both = await star(salesB, a, false);
    expect(both.starred).toBe(false);
    expect(both.pinned_at).not.toBeNull(); // the pin stays
    expect(await pin(salesB, a, false)).toEqual({ starred: false, pinned_at: null });
    expect(await asUser(db, salesB, (tx) => rows(tx, "select 1 from public.lead_stars where lead_id = $1", [a]))).toHaveLength(0);
    // Star then pin, then unpin: the star stays.
    await star(salesB, a);
    await pin(salesB, a);
    expect(await pin(salesB, a, false)).toEqual({ starred: true, pinned_at: null });
    expect((await starred(salesB)).items.map((i) => i.id)).toContain(a);
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

  it("puts pinned leads first in the normal list too; filters still apply", async () => {
    const user = await createUser(db, "sales.allpins", "sales", "All pins");
    const ids: Record<string, string> = {};
    for (const n of ["Echo", "Foxtrot", "Golf"]) ids[n] = await createLead(db, user, { name: n });
    await pin(user, ids.Golf);
    const list = (search?: string) => asUser(db, user, async (tx) => (await one<{ r: Page }>(tx,
      "select public.list_leads(p_search => $1, p_sort => 'name', p_dir => 'asc', p_limit => 100) as r", [search ?? null])).r);
    const all = await list();
    expect(all.items.map((i) => i.id)).toEqual([ids.Golf, ids.Echo, ids.Foxtrot]);
    expect(all.items[0].pinned_at).not.toBeNull();
    expect((await list("Echo")).items.map((i) => i.id)).toEqual([ids.Echo]);
  });

  it("allows at most 10 pins; unpinning frees a slot", async () => {
    const user = await createUser(db, "sales.limit", "sales", "Limit");
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push(await createLead(db, user, { name: `Limit ${i}` }));
    for (const id of ids.slice(0, 10)) await pin(user, id);
    await expect(pin(user, ids[10])).rejects.toThrow(/pin_limit/);
    expect((await pin(user, ids[0])).pinned_at).not.toBeNull(); // re-pinning an existing pin is fine
    await pin(user, ids[0], false);
    expect((await pin(user, ids[10])).pinned_at).not.toBeNull();
    // Direct table writes hit the same limit (a starred, unpinned row).
    await star(user, ids[0]);
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

describe("lead order: New first on the default sort", () => {
  it("puts New-stage leads first (newest first), then pins, then the rest; other sorts keep pins first", async () => {
    const user = await createUser(db, "sales.newfirst", "sales", "New first");
    const contacted = await stageId(db, "Contacted");
    const ids: Record<string, string> = {};
    for (const n of ["Old pinned", "Old contacted", "New one", "New two"]) {
      ids[n] = await createLead(db, user, { name: n });
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const n of ["Old pinned", "Old contacted"]) {
      await asUser(db, user, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [ids[n], contacted]));
    }
    await pin(user, ids["Old pinned"]);
    const list = (sort = "created_at", dir = "desc") => asUser(db, user, async (tx) =>
      (await one<{ r: Page }>(tx, "select public.list_leads(p_sort => $1, p_dir => $2, p_limit => 100) as r", [sort, dir])).r.items.map((i) => i.id));
    expect(await list()).toEqual([ids["New two"], ids["New one"], ids["Old pinned"], ids["Old contacted"]]);
    // Contacting a lead drops it below the pins.
    await asUser(db, user, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [ids["New two"], contacted]));
    expect(await list()).toEqual([ids["New one"], ids["Old pinned"], ids["New two"], ids["Old contacted"]]);
    // Any other sort: pins first, then the sort.
    expect(await list("name", "asc")).toEqual([ids["Old pinned"], ids["New one"], ids["New two"], ids["Old contacted"]]);
    expect((await list("created_at", "asc"))[0]).toBe(ids["Old pinned"]);
  });
});

describe("admin view of another user's stars and pins", () => {
  type ByPage = Page & { items: { id: string; starred: boolean; pinned_at: string | null }[] };
  const starredBy = (viewer: string, target: string | null) => asUser(db, viewer, async (tx) => (await one<{ r: ByPage }>(tx,
    "select public.list_leads(p_starred_only => true, p_starred_by => $1, p_sort => 'name', p_dir => 'asc', p_limit => 100) as r", [target])).r);
  let target: string, starredLead: string, pinnedLead: string, plainLead: string;

  beforeAll(async () => {
    target = await createUser(db, "sales.target", "sales", "Target");
    starredLead = await createLead(db, target, { name: "T starred" });
    pinnedLead = await createLead(db, target, { name: "T pinned" });
    plainLead = await createLead(db, target, { name: "T plain" });
    await star(target, starredLead);
    await pin(target, pinnedLead);
    await star(admin, plainLead); // the admin's own star must not show in the target's view
  });

  it("shows an admin the user's starred and pinned leads with the user's marks", async () => {
    const page = await starredBy(admin, target);
    expect(page.items.map((i) => i.id)).toEqual([pinnedLead, starredLead]);
    expect(page.items[0]).toMatchObject({ starred: false });
    expect(page.items[0].pinned_at).not.toBeNull();
    expect(page.items[1]).toMatchObject({ starred: true, pinned_at: null });
    expect(page.total).toBe(2);
    // The admin's own Starred tab is unchanged.
    expect((await starredBy(admin, null)).items.map((i) => i.id)).toContain(plainLead);
  });

  it("works for a super admin of the company", async () => {
    const owner = await createUser(db, "owner.stars", "super_admin", "Owner");
    expect((await starredBy(owner, target)).items.map((i) => i.id)).toEqual([pinnedLead, starredLead]);
  });

  it("is ignored for sales, and refused for other companies and deactivated users", async () => {
    await star(salesA, await createLead(db, salesA, { name: "A own star" }));
    const own = await starredBy(salesA, target);
    expect(own.items.map((i) => i.id)).not.toContain(starredLead);
    expect(own.items.length).toBeGreaterThan(0);

    const other = await createCompany(db, "Stars Elsewhere");
    const otherAdmin = await createUser(db, "stars.other.admin", "admin", "Other admin", other);
    await expect(starredBy(otherAdmin, target)).rejects.toThrow(/not_found/);

    const gone = await createUser(db, "sales.gone", "sales", "Gone");
    await db.query("update public.profiles set is_active = false where id = $1", [gone]);
    await expect(starredBy(admin, gone)).rejects.toThrow(/not_found/);
  });

  it("leaves lead_stars readable only by their owner", async () => {
    const seen = await asUser(db, admin, (tx) => rows(tx, "select 1 from public.lead_stars where user_id = $1", [target]));
    expect(seen).toHaveLength(0);
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

  it("puts a pinned task first in the normal 'pending' view too", async () => {
    const user = await createUser(db, "sales.fupin", "sales", "FU pin");
    const lead = await createLead(db, user, { name: "PinTasks" });
    const fu = await asUser(db, user, async (tx) => {
      for (const due of ["2099-02-01T04:30:00Z", "2099-02-02T04:30:00Z", "2099-02-03T04:30:00Z"]) {
        await tx.query("insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, 'Call', $2, $3)", [lead, due, user]);
      }
      return rows<{ id: string }>(tx, "select id from public.follow_ups where lead_id = $1 order by due_at", [lead]);
    });
    const [first, second, third] = fu.map((f) => f.id);
    await asUser(db, user, (tx) => tx.query("select public.set_follow_up_pin($1, true)", [third]));
    const page = await asUser(db, user, async (tx) => (await one<{ r: Page }>(tx, "select public.list_follow_ups('pending', null, null, 20, 0) as r")).r);
    expect(page.items.map((i) => i.id)).toEqual([third, first, second]);
  });
});
