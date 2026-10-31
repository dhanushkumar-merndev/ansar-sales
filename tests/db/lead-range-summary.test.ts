import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createUser, nextPhone, rows, type Db } from "./harness";

// 20261008005600_lead_range_summary: list_leads' filters and order moved into private.lead_list_page (unchanged),
// and lead_range_summary counts Sl No a..b of the same list by stage and temperature.

const migration = (file: string) => readFileSync(join(__dirname, "..", "..", "supabase", "migrations", file), "utf8");
function previousVersion(file: string, name: string) {
  const sql = migration(file);
  const start = sql.search(new RegExp(`create (or replace )?function public\\.${name}\\(`));
  const end = sql.indexOf("end $$;", start) + "end $$;".length;
  return sql.slice(start, end)
    .replace(/^create (or replace )?function/, "create or replace function")
    .replace(`public.${name}(`, `public.${name}_before(`);
}

type Item = { id: string; stage_id: string; temperature: string | null };
type Page = { items: Item[]; total: number };
type Summary = {
  from: number; to: number; count: number;
  stages: { id: string; name: string; count: number }[];
  temperatures: { hot: number; medium: number; cold: number; none: number };
};

let db: Db;
let admin: string, salesA: string, salesB: string, account: string;
let stages: { id: string; name: string }[];

async function call<T>(fn: string, userId: string | null, args: Record<string, unknown>) {
  const keys = Object.keys(args);
  const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
  return asUser(db, userId, async (tx) => (await tx.query<{ r: T }>(`select public.${fn}(${named}) as r`, Object.values(args))).rows[0].r);
}

/** Sl No a..b counted from list_leads pages of 20 (the way the screen numbers them). */
async function fromPages(userId: string, filters: Record<string, unknown>, a: number, b: number) {
  const picked: Item[] = [];
  for (let offset = Math.floor((a - 1) / 20) * 20; offset < b; offset += 20) {
    const page = await call<Page>("list_leads", userId, { ...filters, p_limit: 20, p_offset: offset });
    page.items.forEach((it, i) => {
      const sl = offset + i + 1;
      if (sl >= a && sl <= b) picked.push(it);
    });
    if (page.items.length < 20) break;
  }
  const byStage = new Map<string, number>();
  for (const it of picked) byStage.set(it.stage_id, (byStage.get(it.stage_id) ?? 0) + 1);
  const temp = (t: string | null) => picked.filter((it) => it.temperature === t).length;
  return {
    count: picked.length,
    stages: stages.filter((s) => byStage.has(s.id)).map((s) => ({ id: s.id, count: byStage.get(s.id)! })),
    temperatures: { hot: temp("hot"), medium: temp("medium"), cold: temp("cold"), none: temp(null) },
  };
}

const summary = (userId: string | null, filters: Record<string, unknown>, from: number | null, to: number | null) =>
  call<Summary>("lead_range_summary", userId, { ...filters, p_from: from, p_to: to });

beforeAll(async () => {
  db = await createDb();
  await db.exec(previousVersion("20261008005500_separate_star_pin.sql", "list_leads"));
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
  account = await createUser(db, "account", "account", "Account");
  stages = await rows<{ id: string; name: string }>(db,
    "select s.id, s.name from public.pipeline_stages s join public.companies c on c.id = s.company_id where c.name = 'Star Growth Hub' and s.archived_at is null order by s.position, s.id");

  const temps = ["hot", "medium", "cold", null];
  for (const [owner, n] of [[salesA, 70], [salesB, 25], [admin, 15]] as const) {
    await asUser(db, owner, async (tx) => {
      for (let i = 0; i < n; i++) {
        await tx.query(
          "select public.create_lead(p_name => $1, p_phone => $2, p_phone_normalized => $2, p_new_niche => $3, p_stage_id => $4)",
          [`${i % 2 ? "lead" : "Lead"} ${String(i).padStart(2, "0")}`, nextPhone(), ["Retail", "Farms"][i % 2], stages[(i * 7) % stages.length].id],
        );
      }
    });
  }
  const leads = await rows<{ id: string; owner_id: string; n: number }>(db,
    "select id, owner_id, row_number() over (order by created_at, id)::int as n from public.leads order by created_at, id");
  await asService(db, async (tx) => {
    for (const l of leads) await tx.query("update public.leads set temperature = $2 where id = $1", [l.id, temps[l.n % 4]]);
  });
  const aLeads = leads.filter((l) => l.owner_id === salesA);
  for (const l of aLeads.slice(0, 15)) await asUser(db, salesA, (tx) => tx.query("select public.set_lead_star($1, true)", [l.id]));
  for (const l of aLeads.slice(10, 14)) await asUser(db, salesA, (tx) => tx.query("select public.set_lead_pin($1, true)", [l.id]));
  for (const l of leads.slice(40, 44)) await asUser(db, admin, (tx) => tx.query("select public.set_lead_pin($1, true)", [l.id]));
}, 120_000);

const FILTER_SETS: Record<string, unknown>[] = [
  {},
  { p_sort: "name", p_dir: "asc" },
  { p_sort: "status", p_dir: "asc" },
  { p_sort: "created_at", p_dir: "asc" },
  { p_sort: "next_follow_up", p_dir: "asc" },
  { p_starred_only: true },
  { p_search: "lead 1" },
  { p_temperature: "hot" },
];

describe("list_leads after the move to lead_list_page", () => {
  it("returns exactly what 5500's version returned", async () => {
    const extra: Record<string, unknown>[] = [{ p_stage_ids: `{${stages[1].id}}` }, { p_owner_id: salesB }, { p_archived: true }];
    for (const user of [admin, salesA, salesB]) {
      for (const f of [...FILTER_SETS, ...extra]) {
        for (const dir of ["asc", "desc"]) {
          for (const p_offset of [0, 20, 60]) {
            const args = { p_dir: dir, ...f, p_limit: 20, p_offset };
            expect(await call("list_leads", user, args), JSON.stringify(args)).toEqual(await call("list_leads_before", user, args));
          }
        }
      }
    }
    const byA = { p_starred_only: true, p_starred_by: salesA, p_limit: 50 };
    expect(await call("list_leads", admin, byA)).toEqual(await call("list_leads_before", admin, byA));
  });
});

describe("lead_range_summary", () => {
  it("counts the same leads the list shows under those Sl Nos, across pages and past the end", async () => {
    for (const user of [admin, salesA]) {
      for (const f of FILTER_SETS) {
        for (const [a, b] of [[1, 20], [5, 47], [18, 23], [61, 500], [3, 3]]) {
          const s = await summary(user, f, a, b);
          const expected = await fromPages(user, f, a, b);
          expect({ count: s.count, stages: s.stages.map(({ id, count }) => ({ id, count })), temperatures: s.temperatures }, `${JSON.stringify(f)} ${a}-${b}`)
            .toEqual(expected);
          expect(s).toMatchObject({ from: a, to: b });
        }
      }
    }
  });

  it("names the stages in stage order and keeps Sales to their own leads", async () => {
    const s = await summary(salesA, {}, 1, 10000);
    expect(s.count).toBe(70);
    expect(s.stages.map((x) => x.name)).toEqual(stages.filter((st) => s.stages.some((x) => x.id === st.id)).map((st) => st.name));
    expect(s.stages.reduce((n, x) => n + x.count, 0)).toBe(70);
    expect((await summary(salesB, {}, 1, 10000)).count).toBe(25);
    expect((await summary(admin, {}, 1, 10000)).count).toBe(110);
  });

  it("counts another user's stars and pins for an admin, and ignores that for Sales", async () => {
    const byA = await summary(admin, { p_starred_only: true, p_starred_by: salesA }, 1, 100);
    expect(byA.count).toBe(15); // 15 starred, 4 of them pinned
    const own = await summary(salesB, { p_starred_only: true, p_starred_by: salesA }, 1, 100);
    expect(own.count).toBe(0);
  });

  it("refuses bad ranges, Account and signed-out callers", async () => {
    for (const [a, b] of [[0, 5], [5, 4], [1, 10001], [null, 5], [5, null]]) {
      await expect(summary(salesA, {}, a, b)).rejects.toThrow(/invalid_sl_range/);
    }
    await expect(summary(salesA, { p_sort: "phone" }, 1, 5)).rejects.toThrow(/invalid_sort/);
    await expect(summary(account, {}, 1, 5)).rejects.toThrow(/forbidden/);
    await expect(summary(null, {}, 1, 5)).rejects.toThrow();
  });
});
