import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, one, rows, type Db } from "./harness";

// The Star Gardens demo seed (supabase/seed/star-gardens*.sql) against the real schema: it must load,
// every screen's RPC must read it as each role, nothing may point at a missing row, and clean must
// remove all of it. Mirrors what scripts/seed-star-gardens.mjs does, minus the file uploads.

const seed = (name: string) => readFileSync(join(__dirname, "..", "..", "supabase", "seed", name), "utf8");

let db: Db;
let gardens: string;
const ids: Record<string, string> = {};

async function makeUser(username: string, role: string, name: string, extra: string[] = [], projectId?: string) {
  return db.transaction(async (tx) => {
    const id = (await one<{ id: string }>(tx, "insert into auth.users (email, raw_app_meta_data) values ($1, '{}') returning id", [`${username}@login.test`])).id;
    await tx.query("update auth.users set raw_app_meta_data = $2 where id = $1", [id, {
      crm_username: username, crm_display_name: name, crm_role: role, crm_company_id: gardens,
      ...(extra.length ? { crm_extra_roles: extra } : {}), ...(projectId ? { crm_project_id: projectId } : {}),
    }]);
    return id;
  });
}

const rpc = <T,>(uid: string, sql: string, params: unknown[] = []) => asUser(db, uid, async (tx) => (await one<{ r: T }>(tx, `select ${sql} as r`, params)).r);
const projectId = async (code: string) => (await one<{ id: string }>(db, "select id from public.projects where code = $1", [code])).id;

beforeAll(async () => {
  db = await createDb();
  gardens = await createCompany(db, "Star Gardens");
  await db.query("update public.companies set features = array['projects'] where id = $1", [gardens]);
  for (const [k, role, name, extra] of [
    ["admin", "admin", "Demo Admin", ["account"]], ["bdm1", "sales", "Demo BDM Priya", []], ["bdm2", "sales", "Demo BDM Arjun (left)", []],
    ["am1", "architect_manager", "Demo Raj", []], ["am2", "architect_manager", "Demo Meera", ["landscape_designer"]],
    ["ld1", "landscape_designer", "Demo Diny", []], ["ld2", "landscape_designer", "Demo Kiran", ["execution"]],
    ["ld3", "landscape_designer", "Demo Sanjay (Designer, left)", []],
    ["ex1", "execution", "Demo Abhi", []], ["acc", "account", "Demo Accounts", []],
  ] as const) ids[k] = await makeUser(`demo_sg_${k}`, role, name, [...extra]);
  // Like the seed script: the designer who left (and the BDM who left) are switched off.
  await db.query("update public.profiles set is_active = false where username in ('demo_sg_ld3', 'demo_sg_bdm2')");
  await db.exec(seed("star-gardens.sql"));
  ids.hari = await makeUser("demo_sg_client_hari", "client", "Mr. Hari", [], await projectId("SG-DEMO-01"));
  ids.villa = await makeUser("demo_sg_client_villa", "client", "Mrs. Kavya", [], await projectId("SG-DEMO-02"));
  await db.exec(seed("star-gardens-portal.sql"));
}, 120_000);

describe("Star Gardens demo seed", () => {
  it("creates the projects, leads and a timeline for each", async () => {
    const projects = await rows<{ code: string; status: string; phases: number }>(db,
      "select code, status::text, (select count(*)::int from public.project_phases ph where ph.project_id = p.id) as phases from public.projects p order by code");
    expect(projects.map((p) => [p.code, p.status])).toEqual([
      ["SG-DEMO-01", "active"], ["SG-DEMO-02", "active"], ["SG-DEMO-03", "active"], ["SG-DEMO-04", "completed"],
      ["SG-DEMO-05", "on_hold"], ["SG-DEMO-06", "cancelled"], ["SG-DEMO-07", "active"], ["SG-DEMO-08", "active"], ["SG-DEMO-09", "active"],
    ]);
    expect(projects.every((p) => p.phases > 0)).toBe(true);
    expect((await one<{ n: number }>(db, "select count(*)::int as n from public.leads where company_id = $1", [gardens])).n).toBe(20);
  });

  it("leaves no reference pointing at a missing row", async () => {
    // Every single-column foreign key of the tables the seed writes (triggers and FK checks were off while seeding).
    const fks = await rows<{ child: string; col: string; parent: string; pcol: string }>(db, `
      select c.conrelid::regclass::text as child, a.attname as col, c.confrelid::regclass::text as parent, pa.attname as pcol
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
      where c.contype = 'f' and cardinality(c.conkey) = 1
        and c.conrelid::regclass::text in ('projects', 'project_financials', 'project_members', 'project_phases', 'project_phase_items',
          'project_activities', 'project_payment_milestones', 'project_payments', 'site_visits', 'project_boq_revisions', 'project_boq_items',
          'project_site_logs', 'project_snags', 'project_folders', 'project_files', 'project_file_versions', 'project_file_comments',
          'project_file_events', 'leads', 'lead_activities', 'follow_ups', 'niches')`);
    expect(fks.length).toBeGreaterThan(40);
    for (const f of fks) {
      const { n } = await one<{ n: number }>(db, `select count(*)::int as n from ${f.child} c where c.${f.col} is not null
        and not exists (select 1 from ${f.parent} p where p.${f.pcol} = c.${f.col})`);
      expect(n, `${f.child}.${f.col} → ${f.parent}`).toBe(0);
    }
  });

  it("reads as the admin: list, dashboard, every project page", async () => {
    const list = await rpc<{ total: number }>(ids.admin, "public.list_projects()");
    expect(list.total).toBe(6); // open ones only by default: not completed, cancelled or archived
    await rpc(ids.admin, "public.projects_dashboard()");
    for (const code of ["SG-DEMO-01", "SG-DEMO-02", "SG-DEMO-03", "SG-DEMO-04", "SG-DEMO-05", "SG-DEMO-06", "SG-DEMO-07", "SG-DEMO-08"]) {
      const id = await projectId(code);
      await rpc(ids.admin, "public.project_detail($1)", [id]);
      await rpc(ids.admin, "public.project_payment_status($1)", [id]);
      await rpc(ids.admin, "public.list_project_activities($1)", [id]);
      await rpc(ids.admin, "public.project_boq($1)", [id]);
      await rpc(ids.admin, "public.list_project_folder($1)", [id]);
    }
    const handoffs = await rpc<{ name: string }[] | { items: { name: string }[] }>(ids.admin, "public.list_handoff_leads()");
    const names = (Array.isArray(handoffs) ? handoffs : handoffs.items).map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining(["Demo Mrs. Ananya Iyer", "Demo Prestige Lakeside Clubhouse", "Demo Mr. Imran Khan"]));
  });

  it("covers the payment edge cases", async () => {
    type S = { milestones: { label: string; status: string; balance: number }[]; schedule_open: number; extra: number };
    const villa = await rpc<S>(ids.acc, "public.project_payment_status($1)", [await projectId("SG-DEMO-02")]);
    expect(villa.milestones.map((m) => [m.label, m.status, Number(m.balance)])).toEqual([
      ["Advance", "overdue", 269000], ["After design approval", "overdue", 546000], ["After BOQ R2", "upcoming", 1092000],
    ]);
    const park = await rpc<S>(ids.acc, "public.project_payment_status($1)", [await projectId("SG-DEMO-03")]);
    expect(park.milestones.map((m) => m.status)).toEqual(["paid", "paid", "due", "upcoming"]);
    expect(Number(park.extra)).toBe(25000);
    const sunrise = await rpc<S>(ids.acc, "public.project_payment_status($1)", [await projectId("SG-DEMO-04")]);
    expect(sunrise.milestones.every((m) => m.status === "paid")).toBe(true);
    await expect(rpc(ids.am1, "public.project_payment_status($1)", [await projectId("SG-DEMO-01")])).rejects.toThrow(/forbidden/);
    const dues = await rpc<{ total: number }>(ids.acc, "public.list_payment_dues('overdue')");
    expect(dues.total).toBeGreaterThanOrEqual(3);
  });

  it("shows the extended end date next to the planned one", async () => {
    const d = await rpc<{ project: { end_date: string; original_end_date: string } }>(ids.admin, "public.project_detail($1)", [await projectId("SG-DEMO-02")]);
    expect(d.project.original_end_date < d.project.end_date).toBe(true);
  });

  it("shows the storage quota almost full on the large-file project", async () => {
    const u = await rpc<{ used: number; quota: number }>(ids.am2, "public.project_storage_usage($1)", [await projectId("SG-DEMO-08")]);
    expect(Number(u.used) / Number(u.quota)).toBeGreaterThan(0.9);
  });

  it("gives the team their own work and the site visits", async () => {
    for (const k of ["ld1", "ld2", "ex1", "am1", "am2"]) await rpc(ids[k], "public.my_work()");
    const visits = await rpc<{ total: number }>(ids.am1, "public.list_site_visits()");
    expect(visits.total).toBeGreaterThan(0);
    // Designers see only their projects.
    const mine = await rpc<{ total: number }>(ids.ld1, "public.list_projects()");
    expect(mine.total).toBe(3); // open ones: Hari, Villa Greens, Farmhouse (Sunrise is completed)
  });

  it("shows the client only approved files, with their own approvals and requests", async () => {
    type P = { projects: { id: string; files: { name: string; status: string; version_no: number }[] }[] };
    const portal = await rpc<P>(ids.hari, "public.my_project_portal()");
    const files = portal.projects[0].files.map((f) => [f.name, f.status, f.version_no]).sort();
    expect(files).toEqual([
      ["Concept deck.pdf", "approved", 1],
      ["Layout plan.pdf", "client_approved", 2],
      ["Site photo — backyard.png", "approved", 1],
      ["Site photo — front lawn.png", "approved", 1],
    ]);
    const events = await rows<{ type: string }>(db, "select type from public.project_file_events where from_client");
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(["client_viewed", "client_downloaded", "client_approved", "client_changes"]));
  });

  it("removes everything with the clean script, so the demo users can be deleted", async () => {
    await db.exec(seed("star-gardens-clean.sql"));
    expect((await one<{ n: number }>(db, "select count(*)::int as n from public.projects")).n).toBe(0);
    expect((await one<{ n: number }>(db, "select count(*)::int as n from public.leads where company_id = $1", [gardens])).n).toBe(0);
    expect((await one<{ n: number }>(db, "select count(*)::int as n from public.site_visits")).n).toBe(0);
    await db.query("delete from auth.users where email like 'demo\\_sg\\_%'");
    expect((await one<{ n: number }>(db, "select count(*)::int as n from public.profiles where username like 'demo\\_sg\\_%'")).n).toBe(0);
  });
});
