import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createLead, createUser, one, rows, type Db } from "./harness";

let db: Db;
let gardens: string;
let admin: string, bdm: string, bdm2: string, manager: string, designer: string, designer2: string, account: string, execution: string;
let otherAdmin: string;

const phases = (start = "2026-10-01") => [
  { category: "Design", name: "Layout", color: "emerald", planned_start: start, deadline: "2026-10-05", items: ["Site study", "Layout"] },
  { category: "Design", name: "Deck", color: "sky", planned_start: "2026-10-03", deadline: "2026-10-08", needs_client_approval: true },
  { category: "Execution", name: "Execution", color: "amber", planned_start: "2026-10-10", deadline: "2026-10-30" },
];

async function createProject(by: string, opts: { leadId?: string; members?: { user_id: string; role: string }[]; value?: number } = {}) {
  return asUser(db, by, async (tx) => (await one<{ id: string }>(tx,
    `select public.create_project(p_name => 'Mr. Hari Residence', p_client_name => 'Hari', p_start => '2026-10-01', p_end => '2026-10-31',
       p_lead_id => $1, p_contract_value => $2, p_members => $3::jsonb, p_phases => $4::jsonb) as id`,
    [opts.leadId ?? null, opts.value ?? 780000, JSON.stringify(opts.members ?? []), JSON.stringify(phases())])).id);
}
const visibleProjects = (uid: string) => asUser(db, uid, (tx) => rows<{ id: string }>(tx, "select id from public.projects")).then((r) => r.map((x) => x.id));

beforeAll(async () => {
  db = await createDb();
  gardens = await createCompany(db, "Star Gardens");
  await db.query("update public.companies set features = array['projects'] where id = $1", [gardens]);
  admin = await createUser(db, "sg_admin", "admin", "SG Admin", gardens);
  bdm = await createUser(db, "sg_bdm", "sales", "Dhanush", gardens);
  bdm2 = await createUser(db, "sg_bdm2", "sales", "Karthik", gardens);
  manager = await createUser(db, "sg_am", "architect_manager" as never, "Raj", gardens);
  designer = await createUser(db, "sg_ld", "landscape_designer" as never, "Diny", gardens);
  designer2 = await createUser(db, "sg_ld2", "landscape_designer" as never, "Abhi", gardens);
  execution = await createUser(db, "sg_ex", "execution" as never, "Sundar", gardens);
  account = await createUser(db, "sg_acc", "account", "Prema", gardens);
  otherAdmin = await createUser(db, "other_admin", "admin");
});

describe("lead handoff", () => {
  it("lets the BDM hand over their own lead once, and admins see the queue", async () => {
    const lead = await createLead(db, bdm, { name: "Hari" });
    await expect(asUser(db, bdm2, (tx) => tx.query("select public.handoff_lead($1, 'x')", [lead]))).rejects.toThrow(/forbidden/);
    await asUser(db, bdm, (tx) => tx.query("select public.handoff_lead($1, 'Interested, wants a quote')", [lead]));
    await expect(asUser(db, bdm, (tx) => tx.query("select public.handoff_lead($1, null)", [lead]))).rejects.toThrow(/already_handed_off/);
    const queue = await asUser(db, admin, async (tx) => (await one<{ q: { id: string; handoff_note: string }[] }>(tx, "select public.list_handoff_leads() as q")).q);
    expect(queue).toEqual([expect.objectContaining({ id: lead, handoff_note: "Interested, wants a quote" })]);
    await expect(asUser(db, bdm, (tx) => tx.query("select public.list_handoff_leads()"))).rejects.toThrow(/forbidden/);
    const act = await rows<{ type: string }>(db, "select type::text from public.lead_activities where lead_id = $1 order by created_at", [lead]);
    expect(act.map((a) => a.type)).toContain("handed_off");
  });

  it("is not available in companies without the projects module", async () => {
    const sales = await createUser(db, "plain_sales", "sales");
    const lead = await createLead(db, sales);
    await expect(asUser(db, sales, (tx) => tx.query("select public.handoff_lead($1, null)", [lead]))).rejects.toThrow(/forbidden/);
    await expect(createProject(otherAdmin)).rejects.toThrow(/forbidden/);
  });
});

describe("projects", () => {
  let project: string;

  it("only admin creates a project, with code, team, phases and the lead marked closed", async () => {
    const lead = await createLead(db, bdm, { name: "Mr. Hari" });
    await expect(createProject(manager, { leadId: lead })).rejects.toThrow(/forbidden/);
    project = await createProject(admin, { leadId: lead, members: [{ user_id: manager, role: "architect_manager" }, { user_id: designer, role: "landscape_designer" }] });
    const p = await one<{ code: string; lead_id: string }>(db, "select code, lead_id from public.projects where id = $1", [project]);
    expect(p.code).toMatch(/^SG-\d{4}-001$/);
    const ph = await rows<{ name: string; items: number }>(db,
      "select ph.name, (select count(*)::int from public.project_phase_items i where i.phase_id = ph.id) as items from public.project_phases ph where project_id = $1 order by position", [project]);
    expect(ph).toEqual([{ name: "Layout", items: 2 }, { name: "Deck", items: 0 }, { name: "Execution", items: 0 }]);
    const stage = await one<{ status: string }>(db, "select status::text from public.leads where id = $1", [lead]);
    expect(stage.status).toBe("won");
    await expect(createProject(admin, { leadId: lead })).rejects.toThrow(/project_exists/);
    const second = await createProject(admin);
    expect((await one<{ code: string }>(db, "select code from public.projects where id = $1", [second])).code).toMatch(/-002$/);
  });

  it("refuses team members without the matching role", async () => {
    await expect(createProject(admin, { members: [{ user_id: bdm, role: "landscape_designer" }] })).rejects.toThrow(/invalid_member/);
  });

  it("shows a project only to admin, account and its team", async () => {
    expect(await visibleProjects(admin)).toContain(project);
    expect(await visibleProjects(account)).toContain(project);
    expect(await visibleProjects(manager)).toContain(project);
    expect(await visibleProjects(designer)).toContain(project);
    expect(await visibleProjects(designer2)).not.toContain(project);
    expect(await visibleProjects(bdm)).toEqual([]);
    expect(await visibleProjects(otherAdmin)).toEqual([]);
    await expect(asUser(db, designer2, (tx) => tx.query("select public.project_detail($1)", [project]))).rejects.toThrow(/not_found/);
  });

  it("keeps money away from the design team", async () => {
    const fin = (uid: string) => asUser(db, uid, (tx) => rows(tx, "select contract_value from public.project_financials where project_id = $1", [project]));
    await expect(fin(designer)).resolves.toEqual([]);
    await expect(fin(manager)).resolves.toEqual([]);
    await expect(fin(account)).resolves.toHaveLength(1);
    const d = await asUser(db, manager, async (tx) => (await one<{ d: { financials: unknown; can: { manage: boolean; money: boolean } } }>(tx, "select public.project_detail($1) as d", [project])).d);
    expect(d.financials).toBeNull();
    expect(d.can).toMatchObject({ manage: true, money: false });
    await expect(asUser(db, manager, (tx) => tx.query("select public.set_project_financials($1, 100, 10, 1000)", [project]))).rejects.toThrow(/forbidden/);
    await asUser(db, account, (tx) => tx.query("select public.set_project_financials($1, 800, 1000, 800000)", [project]));
    // The money edit is hidden from the team's activity feed.
    const feed = (uid: string) => asUser(db, uid, async (tx) => (await one<{ f: { items: { meta: { money?: boolean } }[] } }>(tx, "select public.list_project_activities($1) as f", [project])).f.items);
    expect((await feed(account)).some((a) => a.meta.money)).toBe(true);
    expect((await feed(manager)).some((a) => a.meta.money)).toBe(false);
  });

  it("lets the phase owner report progress but not move deadlines", async () => {
    const layout = (await one<{ id: string }>(db, "select id from public.project_phases where project_id = $1 and name = 'Layout'", [project])).id;
    await expect(asUser(db, designer, (tx) => tx.query("update public.project_phases set status = 'in_progress' where id = $1", [layout])))
      .resolves.toMatchObject({ affectedRows: 0 }); // not the owner yet
    await asUser(db, manager, (tx) => tx.query("update public.project_phases set owner_id = $2 where id = $1", [layout, designer]));
    await asUser(db, designer, (tx) => tx.query("update public.project_phases set status = 'in_review' where id = $1", [layout]));
    const ph = await one<{ status: string; actual_start: string | null; submitted_on: string | null }>(db,
      "select status::text, actual_start::text, submitted_on::text from public.project_phases where id = $1", [layout]);
    expect(ph.status).toBe("in_review");
    expect(ph.actual_start).not.toBeNull();
    expect(ph.submitted_on).not.toBeNull();
    await expect(asUser(db, designer, (tx) => tx.query("update public.project_phases set deadline = '2026-12-01' where id = $1", [layout]))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, manager, (tx) => tx.query("update public.project_phases set owner_id = $2 where id = $1", [layout, designer2]))).rejects.toThrow(/owner_not_on_project/);
    // The owner ticks checklist items.
    const item = (await one<{ id: string }>(db, "select id from public.project_phase_items where phase_id = $1 order by position limit 1", [layout])).id;
    await asUser(db, designer, (tx) => tx.query("update public.project_phase_items set done_at = now() where id = $1", [item]));
    expect((await one<{ done_by: string }>(db, "select done_by from public.project_phase_items where id = $1", [item])).done_by).toBe(designer);

    const types = await rows<{ type: string }>(db, "select type from public.project_activities where project_id = $1", [project]);
    expect(types.map((t) => t.type)).toEqual(expect.arrayContaining(["project_created", "phase_owner_changed", "phase_status_changed"]));

    // Members submit, managers decide: the owner can't approve, skip or ask for changes.
    for (const status of ["done", "skipped", "changes_requested"]) {
      await expect(asUser(db, designer, (tx) => tx.query("update public.project_phases set status = $2 where id = $1", [layout, status]))).rejects.toThrow(/forbidden/);
    }
    await asUser(db, manager, (tx) => tx.query("update public.project_phases set status = 'changes_requested' where id = $1", [layout]));
    await asUser(db, designer, (tx) => tx.query("update public.project_phases set status = 'in_review' where id = $1", [layout])); // resubmits
    await asUser(db, admin, (tx) => tx.query("update public.project_phases set status = 'done' where id = $1", [layout]));
    await expect(asUser(db, designer, (tx) => tx.query("update public.project_phases set status = 'in_progress' where id = $1", [layout]))).rejects.toThrow(/forbidden/); // can't reopen
    // A submitted date before the start is refused.
    await expect(asUser(db, manager, (tx) => tx.query("update public.project_phases set submitted_on = actual_start - 1 where id = $1", [layout]))).rejects.toThrow(/submitted_after_start/);

    // The whole history, oldest first, with who did it: for the team, not for outsiders.
    const history = await asUser(db, designer, async (tx) => (await one<{ h: { phase_id: string; to: string; by: string }[] }>(tx,
      "select public.project_phase_history($1) as h", [project])).h).then((h) => h.filter((e) => e.phase_id === layout));
    expect(history.map((e) => e.to)).toEqual(["in_review", "changes_requested", "in_review", "done"]);
    expect(history.at(-1)?.by).toBe("SG Admin");
    await expect(asUser(db, bdm, (tx) => tx.query("select public.project_phase_history($1)", [project]))).rejects.toThrow(/not_found/);
  });

  it("derives lateness and lists projects with the late filter", async () => {
    const list = await asUser(db, manager, async (tx) => (await one<{ l: { total: number; items: { id: string; late_phases: number; team: unknown[] }[] } }>(tx,
      "select public.list_projects(p_status => 'all') as l")).l);
    expect(list.items.map((i) => i.id)).toEqual([project]);
    expect(list.items[0].team).toHaveLength(2);
    // Phases in Oct 2026 versus today's IST date: compare with the database's own calculation.
    const late = await one<{ n: number }>(db,
      "select count(*)::int as n from public.project_phases where project_id = $1 and status not in ('done','skipped','in_review') and deadline < private.ist_today()", [project]);
    expect(list.items[0].late_phases).toBe(late.n);
  });

  it("removes a member's access and unassigns their phases", async () => {
    await asUser(db, manager, (tx) => tx.query("select public.set_project_member($1, $2, 'landscape_designer', false)", [project, designer]));
    expect(await visibleProjects(designer)).not.toContain(project);
    const owned = await rows(db, "select id from public.project_phases where project_id = $1 and owner_id = $2", [project, designer]);
    expect(owned).toEqual([]);
    // The architect manager can't add another architect manager; admin can.
    await expect(asUser(db, manager, (tx) => tx.query("select public.set_project_member($1, $2, 'architect_manager', true)", [project, manager]))).rejects.toThrow(/forbidden/);
    await asUser(db, manager, (tx) => tx.query("select public.set_project_member($1, $2, 'execution', true)", [project, execution]));
    expect(await visibleProjects(execution)).toContain(project);
  });
});

describe("projects dashboard", () => {
  it("summarises projects and the team board for admins, and refuses others", async () => {
    const d = await asUser(db, admin, async (tx) => (await one<{ d: { cards: { active_projects: number }; team: { name: string; projects: unknown[] }[] } }>(tx, "select public.projects_dashboard() as d")).d);
    expect(d.cards.active_projects).toBeGreaterThanOrEqual(1);
    expect(d.team.map((t) => t.name)).toEqual(expect.arrayContaining(["Raj", "Dhanush"]));
    expect(d.team.find((t) => t.name === "Raj")!.projects.length).toBeGreaterThanOrEqual(1);
    await expect(asUser(db, designer, (tx) => tx.query("select public.projects_dashboard()"))).rejects.toThrow(/forbidden/);
    const m = await asUser(db, manager, async (tx) => (await one<{ d: { cards: { collected_month: number | null } } }>(tx, "select public.projects_dashboard() as d")).d);
    expect(m.cards.collected_month).toBeNull();
  });
});

describe("extending a project", () => {
  it("keeps the planned end date, shows the new one, and logs the extension", async () => {
    const id = await asUser(db, admin, async (tx) => (await one<{ id: string }>(tx,
      "select public.create_project(p_name => 'Extend me', p_client_name => 'X', p_start => '2026-10-01', p_end => '2026-11-01') as id")).id);
    await asUser(db, admin, (tx) => tx.query("update public.projects set end_date = '2026-11-20' where id = $1", [id]));
    // Nobody can rewrite the planned end (the trigger keeps it even for the database owner).
    await db.query("update public.projects set original_end_date = '2026-12-31' where id = $1", [id]);
    const d = await asUser(db, admin, async (tx) => (await one<{ d: { project: { end_date: string; original_end_date: string } } }>(tx,
      "select public.project_detail($1) as d", [id])).d);
    expect([d.project.original_end_date, d.project.end_date]).toEqual(["2026-11-01", "2026-11-20"]);
    const log = await one<{ meta: { changes: { End: { from: string; to: string } } } }>(db,
      "select meta from public.project_activities where project_id = $1 and type = 'project_updated' order by created_at desc limit 1", [id]);
    expect(log.meta.changes.End).toEqual({ from: "2026-11-01", to: "2026-11-20" });
  });
});


describe("editing the timeline sheet in place", () => {
  // The same statements the sheet's server actions run (patchPhase, addPhaseQuick, renameStage, reorderPhaseItems).
  it("lets managers add phases into a stage, rename stages and edit steps; the owner edits only their steps and progress", async () => {
    const id = await asUser(db, admin, async (tx) => (await one<{ id: string }>(tx,
      `select public.create_project(p_name => 'Sheet edits', p_client_name => 'S', p_start => '2026-10-01', p_end => '2026-10-31',
         p_members => $1::jsonb, p_phases => $2::jsonb) as id`,
      [JSON.stringify([{ user_id: manager, role: "architect_manager" }, { user_id: designer, role: "landscape_designer" }]), JSON.stringify(phases())])).id);
    const order = () => rows<{ name: string; category: string }>(db,
      "select name, category from public.project_phases where project_id = $1 and archived_at is null order by position, id", [id]);
    const deck = (await one<{ id: string }>(db, "select id from public.project_phases where project_id = $1 and name = 'Deck'", [id])).id;

    // A new phase into "Design", right after its last phase, with its own steps.
    await asUser(db, manager, async (tx) => {
      const ph = await one<{ id: string }>(tx, `insert into public.project_phases (project_id, category, name, color, planned_start, deadline, position)
        values ($1, 'Design', 'BOQ — R2', 'violet', '2026-10-09', '2026-10-09', 99) returning id`, [id]);
      const ids = (await rows<{ id: string }>(tx, "select id from public.project_phases where project_id = $1 and id <> $2 order by position, id", [id, ph.id])).map((r) => r.id);
      ids.splice(ids.indexOf(deck) + 1, 0, ph.id);
      await tx.query("select public.reorder_project_phases($1, $2)", [id, ids]);
      await tx.query("insert into public.project_phase_items (phase_id, title, position) values ($1, 'Detailed BOQ', 1), ($1, 'Rates check', 2)", [ph.id]);
    });
    expect((await order()).map((p) => p.name)).toEqual(["Layout", "Deck", "BOQ — R2", "Execution"]);

    // Rename the stage: every phase in it follows.
    await asUser(db, manager, (tx) => tx.query("update public.project_phases set category = 'Concept design' where project_id = $1 and category = 'Design'", [id]));
    expect((await order()).map((p) => p.category)).toEqual(["Concept design", "Concept design", "Concept design", "Execution"]);

    // The owner renames and reorders the steps of their phase…
    const layout = (await one<{ id: string }>(db, "select id from public.project_phases where project_id = $1 and name = 'Layout'", [id])).id;
    await asUser(db, manager, (tx) => tx.query("update public.project_phases set owner_id = $2 where id = $1", [layout, designer]));
    const steps = await rows<{ id: string }>(db, "select id from public.project_phase_items where phase_id = $1 order by position, id", [layout]);
    await asUser(db, designer, async (tx) => {
      await tx.query("update public.project_phase_items set title = 'Site study + survey' where id = $1", [steps[0].id]);
      await tx.query("update public.project_phase_items set position = 1 where id = $1", [steps[1].id]);
      await tx.query("update public.project_phase_items set position = 2 where id = $1", [steps[0].id]);
      await tx.query("update public.project_phases set remark = 'Waiting for survey' where id = $1", [layout]);
    });
    expect((await rows<{ title: string }>(db, "select title from public.project_phase_items where phase_id = $1 order by position", [layout])).map((s) => s.title))
      .toEqual(["Layout", "Site study + survey"]);
    // …but can't rename the phase or its stage, add phases, or touch someone else's steps.
    await expect(asUser(db, designer, (tx) => tx.query("update public.project_phases set name = 'X' where id = $1", [layout]))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, designer, (tx) => tx.query("update public.project_phases set category = 'X' where id = $1", [layout]))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, designer, (tx) => tx.query(`insert into public.project_phases (project_id, category, name, planned_start, deadline)
      values ($1, 'Design', 'Mine', '2026-10-02', '2026-10-03')`, [id]))).rejects.toThrow(/row-level security/);
    const execStep = await asUser(db, manager, async (tx) => (await one<{ id: string }>(tx,
      "insert into public.project_phase_items (phase_id, title, position) select id, 'Order plants', 1 from public.project_phases where project_id = $1 and name = 'Execution' returning id", [id])).id);
    await expect(asUser(db, designer, (tx) => tx.query("update public.project_phase_items set title = 'X' where id = $1", [execStep]))).resolves.toMatchObject({ affectedRows: 0 });
    // A deadline before the start is refused by the database too.
    await expect(asUser(db, manager, (tx) => tx.query("update public.project_phases set deadline = planned_start - 1 where id = $1", [layout]))).rejects.toThrow(/check/);
  });
});

describe("projects as year → month folders", () => {
  it("counts each month's projects (by start date) for what the person may see, and lists one month", async () => {
    const make = (name: string, start: string, end: string, members: { user_id: string; role: string }[] = []) => asUser(db, admin, async (tx) =>
      (await one<{ id: string }>(tx, `select public.create_project(p_name => $1, p_client_name => 'F', p_start => $2, p_end => $3, p_members => $4::jsonb) as id`,
        [name, start, end, JSON.stringify(members)])).id);
    await make("Folder Jan A", "2025-01-05", "2025-02-01", [{ user_id: designer2, role: "landscape_designer" }]);
    await make("Folder Jan B", "2025-01-20", "2025-03-01");
    const late = await make("Folder Mar", "2025-03-02", "2025-04-01");
    await asUser(db, admin, (tx) => tx.query(`insert into public.project_phases (project_id, category, name, planned_start, deadline)
      values ($1, 'Design', 'Late one', '2025-03-02', '2025-03-05')`, [late]));

    type M = { year: number; month: number; total: number; late: number; colors: string[] };
    const months = (uid: string, late = false) => asUser(db, uid, async (tx) => (await one<{ m: M[] }>(tx, "select public.project_months('all', $1) as m", [late])).m);
    const mine = (await months(admin)).filter((m) => m.year === 2025);
    expect(mine.map((m) => [m.month, m.total, m.late])).toEqual([[3, 1, 1], [1, 2, 0]]); // newest first
    expect(mine[1].colors).toHaveLength(2);
    expect((await months(admin, true)).filter((m) => m.year === 2025).map((m) => m.month)).toEqual([3]);
    // A designer counts only their own projects.
    expect((await months(designer2)).filter((m) => m.year === 2025).map((m) => [m.month, m.total])).toEqual([[1, 1]]);
    await expect(asUser(db, bdm, (tx) => tx.query("select public.project_months()"))).rejects.toThrow(/forbidden/);

    const jan = await asUser(db, admin, async (tx) => (await one<{ l: { total: number; items: { name: string }[] } }>(tx,
      "select public.list_projects(p_status => 'all', p_sort => 'start', p_from => '2025-01-01', p_to => '2025-02-01') as l")).l);
    expect([jan.total, jan.items.map((p) => p.name)]).toEqual([2, ["Folder Jan A", "Folder Jan B"]]);
    // The old call (no dates) still works for the list view and the deployed app.
    await asUser(db, admin, (tx) => tx.query("select public.list_projects(p_search => 'Folder', p_status => 'all')"));
  });
});

describe("team work", () => {
  it("shows a manager what the people on their projects are doing — and nobody else", async () => {
    const id = await asUser(db, admin, async (tx) => (await one<{ id: string }>(tx,
      `select public.create_project(p_name => 'Team work', p_client_name => 'T', p_start => '2026-10-01', p_end => '2026-10-31',
         p_members => $1::jsonb, p_phases => $2::jsonb) as id`,
      [JSON.stringify([{ user_id: manager, role: "architect_manager" }, { user_id: designer, role: "landscape_designer" }]), JSON.stringify(phases())])).id);
    const [layout, deck] = (await rows<{ id: string }>(db, "select id from public.project_phases where project_id = $1 order by position", [id])).map((r) => r.id);
    await asUser(db, manager, (tx) => tx.query("update public.project_phases set owner_id = $2 where id in ($1, $3)", [layout, designer, deck]));
    await asUser(db, designer, async (tx) => {
      await tx.query("update public.project_phases set status = 'in_progress' where id = $1", [deck]);
      await tx.query("update public.project_phases set status = 'in_review' where id = $1", [layout]);
      await tx.query("select public.add_project_note($1, 'Survey done')", [id]);
    });
    await asUser(db, manager, (tx) => tx.query("update public.project_phases set status = 'done' where id = $1", [layout]));

    type Person = { id: string; name: string; in_progress: number; submitted: number; approved: number; phases: { name: string; status: string; project: string }[];
      recent: { type: string; project: string }[]; projects: { name: string }[] };
    const team = async (uid: string) => asUser(db, uid, async (tx) => (await one<{ t: { people: Person[] } }>(tx, "select public.team_work(30) as t")).t.people);

    const mine = await team(manager);
    const diny = mine.find((p) => p.id === designer)!;
    expect(diny.projects.map((p) => p.name)).toContain("Team work");
    expect(diny.phases.filter((p) => p.project === "Team work").map((p) => [p.name, p.status])).toEqual([["Deck", "in_progress"]]);
    expect([diny.submitted >= 1, diny.approved >= 1]).toEqual([true, true]);
    expect(diny.recent.map((r) => r.type)).toEqual(expect.arrayContaining(["phase_status_changed", "note"]));
    expect(mine.some((p) => p.id === manager)).toBe(false); // not themselves
    // Only people on the manager's projects: not the BDMs or a designer on nobody's project of theirs.
    expect(mine.some((p) => p.id === bdm || p.id === bdm2)).toBe(false);

    // The dashboard's team board follows the same rule for managers, and shows lead counts to admins only.
    const board = await asUser(db, manager, async (tx) => (await one<{ d: { team: { id: string; leads: unknown }[] } }>(tx, "select public.projects_dashboard() as d")).d.team);
    expect(board.some((p) => p.id === bdm)).toBe(false);
    const adminBoard = await asUser(db, admin, async (tx) => (await one<{ d: { team: { id: string; leads: unknown }[] } }>(tx, "select public.projects_dashboard() as d")).d.team);
    expect(adminBoard.find((p) => p.id === bdm)?.leads).not.toBeNull();

    await expect(asUser(db, designer, (tx) => tx.query("select public.team_work()"))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, account, (tx) => tx.query("select public.team_work()"))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, manager, (tx) => tx.query("select public.team_work(365)"))).rejects.toThrow(/invalid_page/);
  });
});
