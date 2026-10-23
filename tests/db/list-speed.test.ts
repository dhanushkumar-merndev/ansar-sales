import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createUser, nextPhone, rows, type Db } from "./harness";

// 20261008004700_list_speed rewrote list_leads and the dashboards for speed only.
// The versions before it are created here as *_before, and both must return exactly the same JSON
// for every view, filter, sort and page, for Admin and Sales.

const migration = (file: string) => readFileSync(join(__dirname, "..", "..", "supabase", "migrations", file), "utf8");

function previousVersion(file: string, name: string) {
  const sql = migration(file);
  const start = sql.search(new RegExp(`create (or replace )?function public\\.${name}\\(`));
  const end = sql.indexOf("end $$;", start) + "end $$;".length;
  return sql.slice(start, end)
    .replace(/^create (or replace )?function/, "create or replace function")
    .replace(`public.${name}(`, `public.${name}_before(`);
}

// LIST_SPEED_SCALE=8 seeds ~2,000 leads (like the perf sandbox) for the timing below; CI runs the small seed.
const SCALE = Number(process.env.LIST_SPEED_SCALE ?? 1);

let db: Db;
let admin: string, salesA: string, salesB: string, otherAdmin: string;
let stages: { id: string }[];

async function call(fn: string, userId: string, args: Record<string, unknown>) {
  const keys = Object.keys(args);
  const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
  return asUser(db, userId, async (tx) => (await tx.query<{ r: unknown }>(`select public.${fn}(${named}) as r`, Object.values(args))).rows[0].r);
}

async function same(fn: string, userId: string, args: Record<string, unknown>) {
  const [before, after] = [await call(`${fn}_before`, userId, args), await call(fn, userId, args)];
  expect(after, `${fn} ${JSON.stringify(args)}`).toEqual(before);
  return after as { items?: unknown[]; total?: number };
}

beforeAll(async () => {
  db = await createDb();
  await db.exec(previousVersion("20261008004300_lead_temperature.sql", "list_leads"));
  await db.exec(previousVersion("20261006009200_pipeline_stages.sql", "dashboard_admin"));
  await db.exec(previousVersion("20261006009200_pipeline_stages.sql", "dashboard_sales"));

  admin = await createUser(db, "admin", "admin");
  salesA = await createUser(db, "sales.a", "sales");
  salesB = await createUser(db, "sales.b", "sales");
  const other = await createCompany(db, "Other Co");
  otherAdmin = await createUser(db, "other.admin", "admin", "Other admin", other);
  stages = await rows<{ id: string }>(db, "select s.id from public.pipeline_stages s join public.companies c on c.id = s.company_id where c.name = 'Star Growth Hub' order by s.position");

  // 240 leads (x SCALE) in one company (some sharing created_at, names with mixed case), 30 in another.
  const temps = ["hot", "medium", "cold", null];
  for (const [owner, n] of [[salesA, 120 * SCALE], [salesB, 80 * SCALE], [admin, 40 * SCALE]] as const) {
    await asUser(db, owner, async (tx) => {
      for (let i = 0; i < n; i++) {
        await tx.query(
          `select public.create_lead(p_name => $1, p_phone => $2, p_phone_normalized => $2, p_new_niche => $3, p_stage_id => $4,
             p_email => $5, p_company_name => $6)`,
          [`${i % 3 ? "lead" : "Lead"} ${String(i).padStart(3, "0")}`, nextPhone(), ["Retail", "Health", "Farms"][i % 3], stages[i % stages.length].id,
            i % 4 ? null : `x${i}@example.com`, i % 5 ? null : `Biz ${i}`],
        );
      }
    });
  }
  await asUser(db, otherAdmin, async (tx) => {
    for (let i = 0; i < 30; i++) {
      await tx.query(`select public.create_lead(p_name => $1, p_phone => $2, p_phone_normalized => $2, p_new_niche => 'Retail')`, [`Other ${i}`, nextPhone()]);
    }
  });
  const leads = await rows<{ id: string; owner_id: string; n: number }>(db,
    "select id, owner_id, row_number() over (order by created_at, id)::int as n from public.leads order by created_at, id");
  await asService(db, async (tx) => {
    for (const l of leads) {
      await tx.query("update public.leads set temperature = $2 where id = $1", [l.id, temps[l.n % 4]]);
    }
  });

  // Follow-ups: two per lead at spread times, then completed, cancelled, moved into the past or to today.
  for (const l of leads) {
    await asUser(db, l.owner_id, async (tx) => {
      for (const k of [0, 1]) {
        await tx.query("insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, $2, now() + make_interval(hours => $3), $4)",
          [l.id, k ? "Send proposal" : "Call back", 2 + ((l.n * 7 + k * 13) % 900), l.owner_id]);
      }
    });
  }
  const fus = await rows<{ id: string; assignee_id: string; n: number }>(db,
    "select id, assignee_id, row_number() over (order by created_at, id)::int as n from public.follow_ups");
  for (const f of fus) {
    if (f.n % 5 === 0) await asUser(db, f.assignee_id, (tx) => tx.query("select public.complete_follow_up(p_id => $1, p_outcome => 'Done')", [f.id]));
    else if (f.n % 11 === 0) await asUser(db, f.assignee_id, (tx) => tx.query("update public.follow_ups set state = 'cancelled' where id = $1", [f.id]));
    else if (f.n % 7 === 0) await asService(db, (tx) => tx.query("update public.follow_ups set due_at = now() - make_interval(hours => $2) where id = $1", [f.id, f.n % 50]));
    else if (f.n % 13 === 0) await asService(db, (tx) => tx.query(
      "update public.follow_ups set due_at = date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' + make_interval(mins => $2) where id = $1", [f.id, f.n % 1400]));
  }

  // Stars and pins for Sales A and Admin, and a few archived leads.
  const aLeads = leads.filter((l) => l.owner_id === salesA);
  for (const l of aLeads.slice(0, 12)) await asUser(db, salesA, (tx) => tx.query("select public.set_lead_star(p_lead_id => $1, p_starred => true)", [l.id]));
  for (const l of aLeads.slice(0, 3)) await asUser(db, salesA, (tx) => tx.query("select public.set_lead_pin(p_lead_id => $1, p_pinned => true)", [l.id]));
  for (const l of leads.slice(5, 9)) await asUser(db, admin, (tx) => tx.query("select public.set_lead_pin(p_lead_id => $1, p_pinned => true)", [l.id]));
  const aFus = fus.filter((f) => f.assignee_id === salesA);
  for (const f of aFus.slice(0, 10)) await asUser(db, salesA, (tx) => tx.query("select public.set_follow_up_star(p_follow_up_id => $1, p_starred => true)", [f.id]));
  for (const f of aFus.slice(0, 2)) await asUser(db, salesA, (tx) => tx.query("select public.set_follow_up_pin(p_follow_up_id => $1, p_pinned => true)", [f.id]));
  for (const l of leads.slice(20, 26)) await asUser(db, admin, (tx) => tx.query("update public.leads set archived_at = now() where id = $1", [l.id]));
  await db.exec("analyze"); // planner statistics, as a live database has
}, 600_000);

describe("list_leads: same results as before 20261008004700", () => {
  const sorts = ["created_at", "updated_at", "name", "status", "next_follow_up"];
  it("for every sort, direction and page, as Admin and Sales", async () => {
    for (const user of [admin, salesA]) {
      for (const p_sort of sorts) {
        for (const p_dir of ["asc", "desc"]) {
          for (const p_offset of [0, 50, 100, 200]) await same("list_leads", user, { p_sort, p_dir, p_limit: 50, p_offset });
        }
      }
    }
  });

  it("for every filter", async () => {
    const filters: Record<string, unknown>[] = [
      { p_search: "lead 01" }, { p_search: "Biz" }, { p_search: "example.com" }, { p_search: "90000001" }, { p_search: "100%_" },
      { p_stage_ids: `{${stages[1].id}}` }, { p_overdue_only: true }, { p_starred_only: true }, { p_temperature: "hot" },
      { p_created_from: new Date(Date.now() - 3_600_000).toISOString(), p_created_to: new Date(Date.now() + 3_600_000).toISOString() },
      { p_owner_id: salesB }, { p_archived: true }, { p_overdue_only: true, p_sort: "next_follow_up", p_dir: "asc" },
    ];
    for (const user of [admin, salesA, salesB]) {
      for (const f of filters) await same("list_leads", user, { p_limit: 20, ...f });
    }
  });

  it("keeps Sales A to their own leads and the other company out", async () => {
    const r = await same("list_leads", salesA, { p_limit: 100 });
    expect(r.total).toBe(120 * SCALE - 6); // the seed archived 6 of them
    expect(r.items?.every((l) => (l as { owner: { id: string } }).owner.id === salesA)).toBe(true);
    const other = await same("list_leads", otherAdmin, { p_limit: 100 });
    expect(other.total).toBe(30);
  });
});

describe("dashboards: same results as before 20261008004700", () => {
  it("for Admin and Sales", async () => {
    const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const r = (await same("dashboard_admin", admin, { p_from: "2026-01-01", p_to: today })) as unknown as { cards: { today_pending: number; overdue: number } };
    expect(r.cards.today_pending).toBeGreaterThan(0);
    expect(r.cards.overdue).toBeGreaterThan(0);
    await same("dashboard_admin", otherAdmin, { p_days: 30 });
    for (const user of [salesA, salesB]) await same("dashboard_sales", user, { p_from: "2026-01-01", p_to: today });
  });
});

describe("timing (informational)", () => {
  it("prints the median of 15 calls, before → after", async () => {
    const median = async (fn: string, user: string, args: Record<string, unknown>) => {
      const t: number[] = [];
      for (let i = 0; i < 15; i++) {
        const s = performance.now();
        await call(fn, user, args);
        t.push(performance.now() - s);
      }
      return t.sort((a, b) => a - b)[7];
    };
    const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const cases: [string, string, Record<string, unknown>][] = [
      ["list_leads", admin, { p_limit: 50 }],
      ["list_leads", salesA, { p_limit: 50 }],
      ["list_leads", admin, { p_limit: 50, p_sort: "status", p_dir: "asc" }],
      ["dashboard_admin", admin, { p_from: "2026-01-01", p_to: today }],
    ];
    for (const [user, view] of [[admin, "overdue"], [salesA, "overdue"], [salesA, "upcoming"], [salesA, "today"]] as const) {
      const t = await median("list_follow_ups", user, { p_view: view, p_limit: 20 });
      console.log(`list_follow_ups ${user === admin ? "admin" : "sales"} ${view} (unchanged): ${t.toFixed(1)} ms`);
    }
    for (const [fn, user, args] of cases) {
      const before = await median(`${fn}_before`, user, args);
      const after = await median(fn, user, args);
      console.log(`${fn} ${user === admin ? "admin" : "sales"} ${JSON.stringify(args)}: ${before.toFixed(1)} → ${after.toFixed(1)} ms`);
    }
  });
});
