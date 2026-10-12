import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createLead, createUser, one, rows, type Db } from "./harness";

let db: Db;
let gardens: string;
let admin: string, bdm: string, bdm2: string, manager: string, designer: string, account: string;
let project: string;

const schedule = (by: string, v: { project?: string; lead?: string; to: string }) => asUser(db, by, async (tx) => (await one<{ id: string }>(tx,
  "insert into public.site_visits (project_id, lead_id, assigned_to, scheduled_at, purpose) values ($1, $2, $3, now() + interval '1 hour', 'Measure the garden') returning id",
  [v.project ?? null, v.lead ?? null, v.to])).id);
const checkIn = (by: string, id: string, lat: number, lng: number, pin = false) => asUser(db, by, async (tx) =>
  (await one<{ r: { distance_m: number | null; pinned: boolean } }>(tx, "select public.site_visit_check_in($1, $2, $3, 12, $4) as r", [id, lat, lng, pin])).r);

beforeAll(async () => {
  db = await createDb();
  gardens = await createCompany(db, "Star Gardens");
  await db.query("update public.companies set features = array['projects'] where id = $1", [gardens]);
  admin = await createUser(db, "sv_admin", "admin", "Admin", gardens);
  bdm = await createUser(db, "sv_bdm", "sales", "Dhanush", gardens);
  bdm2 = await createUser(db, "sv_bdm2", "sales", "Karthik", gardens);
  manager = await createUser(db, "sv_am", "architect_manager" as never, "Raj", gardens);
  designer = await createUser(db, "sv_ld", "landscape_designer" as never, "Diny", gardens);
  account = await createUser(db, "sv_acc", "account", "Prema", gardens);
  project = await asUser(db, admin, async (tx) => (await one<{ id: string }>(tx,
    `select public.create_project(p_name => 'Hari', p_client_name => 'Hari', p_start => '2026-10-01', p_end => '2026-11-01',
      p_members => $1::jsonb) as id`, [JSON.stringify([{ user_id: manager, role: "architect_manager" }])])).id);
});

describe("site visits", () => {
  it("lets a BDM plan a visit to their own lead, and the visitor see it", async () => {
    const lead = await createLead(db, bdm);
    const visit = await schedule(bdm, { lead, to: manager });
    const seen = (uid: string) => asUser(db, uid, (tx) => rows<{ id: string }>(tx, "select id from public.site_visits where id = $1", [visit]));
    expect(await seen(manager)).toHaveLength(1);
    expect(await seen(bdm)).toHaveLength(1);
    expect(await seen(bdm2)).toHaveLength(0);
    expect(await seen(account)).toHaveLength(0);
    await expect(schedule(bdm2, { lead, to: bdm2 })).rejects.toThrow();
    await expect(schedule(bdm, { lead, to: account })).rejects.toThrow(/invalid_visitor/);
  });

  it("checks in with GPS, sets the first site pin, then measures the distance", async () => {
    const first = await schedule(manager, { project, to: manager });
    expect(await checkIn(manager, first, 12.971599, 77.594566, true)).toEqual({ distance_m: 0, pinned: true });
    const pin = await one<{ site_lat: string }>(db, "select site_lat::text from public.projects where id = $1", [project]);
    expect(pin.site_lat).toBe("12.971599");

    const second = await schedule(admin, { project, to: designer });
    // ~1.1 km north of the pin.
    const r = await checkIn(designer, second, 12.981599, 77.594566);
    expect(r.distance_m).toBeGreaterThan(1000);
    expect(r.distance_m).toBeLessThan(1200);
    const v = await one<{ status: string; distance_from_site_m: number }>(db, "select status, distance_from_site_m from public.site_visits where id = $1", [second]);
    expect(v).toEqual({ status: "checked_in", distance_from_site_m: r.distance_m });
  });

  it("never lets users write the location directly", async () => {
    const visit = await schedule(manager, { project, to: manager });
    await expect(asUser(db, manager, (tx) => tx.query("update public.site_visits set check_in_lat = 1 where id = $1", [visit]))).rejects.toThrow();
    await expect(checkIn(bdm2, visit, 1, 1)).rejects.toThrow(/not_found/);
  });

  it("completes a visit, records it in the project feed and lists it", async () => {
    const visit = await schedule(manager, { project, to: manager });
    await asUser(db, manager, (tx) => tx.query("update public.site_visits set status = 'completed', outcome = 'Measured 65 x 12 ft' where id = $1", [visit]));
    const types = await rows<{ type: string }>(db, "select type from public.project_activities where project_id = $1", [project]);
    expect(types.map((t) => t.type)).toEqual(expect.arrayContaining(["visit_scheduled", "visit_checked_in", "visit_completed"]));
    const list = await asUser(db, manager, async (tx) => (await one<{ l: { total: number; items: { id: string; project: { name: string } }[] } }>(tx,
      "select public.list_site_visits('past', true) as l")).l);
    expect(list.items.map((i) => i.id)).toContain(visit);
    expect(list.items[0].project.name).toBe("Hari");
  });
});
