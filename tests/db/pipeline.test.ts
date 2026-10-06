import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createLead, createUser, one, rows, stageId, type Db } from "./harness";

let db: Db;
let gardens: string;
let adminA: string, salesA: string, adminB: string, salesB: string;

type Stage = { id: string; name: string; position: number; kind: string };
const stages = (userId: string) =>
  asUser(db, userId, (tx) => rows<Stage>(tx, "select id, name, position, kind from public.pipeline_stages where archived_at is null order by position"));
const save = (userId: string, id: string | null, name: string, kind = "open", color = "sky") =>
  asUser(db, userId, async (tx) => (await one<{ id: string }>(tx, "select public.save_pipeline_stage($1, $2, $3, $4) as id", [id, name, kind, color])).id);
const lead = (id: string) => one<{ stage_id: string; status: string }>(db, "select stage_id, status from public.leads where id = $1", [id]);

beforeAll(async () => {
  db = await createDb();
  gardens = await createCompany(db, "Star Gardens");
  adminA = await createUser(db, "admin_a", "admin");
  salesA = await createUser(db, "sales_a", "sales");
  adminB = await createUser(db, "admin_b", "admin", "Admin B", gardens);
  salesB = await createUser(db, "sales_b", "sales", "Sales B", gardens);
});

describe("pipeline stages", () => {
  it("seeds every company with the default stages and starts leads in the first one", async () => {
    expect((await stages(adminB)).map((s) => [s.name, s.kind])).toEqual([
      ["New", "open"], ["Contacted", "open"], ["Interested", "open"], ["Proposal sent", "open"], ["Won", "won"], ["Lost", "lost"],
    ]);
    const id = await createLead(db, salesB);
    expect(await lead(id)).toEqual({ stage_id: await stageId(db, "New", gardens), status: "open" });
  });

  it("adds a company's own stage before won/lost, used only in that company", async () => {
    const visit = await save(adminB, null, "Site visit");
    expect((await stages(adminB)).map((s) => s.name)).toEqual(["New", "Contacted", "Interested", "Proposal sent", "Site visit", "Won", "Lost"]);
    expect((await stages(adminA)).map((s) => s.name)).not.toContain("Site visit");

    const b = await createLead(db, salesB);
    await asUser(db, salesB, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [b, visit]));
    expect(await lead(b)).toMatchObject({ stage_id: visit, status: "open" });
    const history = await one<{ meta: Record<string, string> }>(db, "select meta from public.lead_activities where lead_id = $1 and type = 'status_changed'", [b]);
    expect(history.meta).toMatchObject({ from: "New", to: "Site visit", to_kind: "open", to_stage_id: visit });

    const a = await createLead(db, salesA);
    await expect(asUser(db, salesA, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [a, visit]))).rejects.toThrow(/stage_not_found/);
    await expect(asUser(db, salesA, (tx) => tx.query(
      "select public.create_lead(p_name => 'X', p_phone => '+919811111111', p_phone_normalized => '+919811111111', p_new_niche => 'Retail', p_stage_id => $1)", [visit])))
      .rejects.toThrow(/stage_not_found/);
  });

  it("status follows the stage's kind, also when the kind changes", async () => {
    const b = await createLead(db, salesB);
    const deal = await save(adminB, null, "Deal done");
    await asUser(db, salesB, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [b, deal]));
    expect((await lead(b)).status).toBe("open");
    await save(adminB, deal, "Deal done", "won", "emerald");
    expect((await lead(b)).status).toBe("won");
    const dash = await asUser(db, adminB, async (tx) => (await one<{ r: { cards: { won_leads: number }; stages: { name: string; count: number }[] } }>(tx,
      "select public.dashboard_admin() as r")).r);
    expect(dash.cards.won_leads).toBe(1);
    expect(dash.stages.find((s) => s.name === "Deal done")?.count).toBe(1);
  });

  it("archives a stage only after moving its leads, and keeps one open, won and lost stage", async () => {
    const temp = await save(adminB, null, "Temp");
    const b = await createLead(db, salesB);
    await asUser(db, salesB, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [b, temp]));
    await expect(asUser(db, adminB, (tx) => tx.query("select public.archive_pipeline_stage($1)", [temp]))).rejects.toThrow(/stage_has_leads/);
    const contacted = await stageId(db, "Contacted", gardens);
    const moved = await asUser(db, adminB, async (tx) => (await one<{ n: number }>(tx, "select public.archive_pipeline_stage($1, $2) as n", [temp, contacted])).n);
    expect(moved).toBe(1);
    expect((await lead(b)).stage_id).toBe(contacted);

    const lost = await stageId(db, "Lost", gardens);
    await expect(asUser(db, adminB, (tx) => tx.query("select public.archive_pipeline_stage($1)", [lost]))).rejects.toThrow(/pipeline_incomplete/);
    await expect(save(adminB, null, "contacted")).rejects.toThrow(/stage_name_taken/);
  });

  it("reorders, and only admins manage stages", async () => {
    const list = await stages(adminB);
    const reversedOpen = [...list.filter((s) => s.kind === "open").reverse(), ...list.filter((s) => s.kind !== "open")];
    await asUser(db, adminB, (tx) => tx.query("select public.reorder_pipeline_stages($1::uuid[])", [reversedOpen.map((s) => s.id)]));
    expect((await stages(adminB)).map((s) => s.id)).toEqual(reversedOpen.map((s) => s.id));
    await expect(asUser(db, adminB, (tx) => tx.query("select public.reorder_pipeline_stages($1::uuid[])", [[list[0].id]]))).rejects.toThrow(/invalid_stage_order/);
    await expect(save(salesB, null, "Mine")).rejects.toThrow(/forbidden/);
    await expect(asUser(db, salesB, (tx) => tx.query("insert into public.pipeline_stages (company_id, name, position) values ($1, 'x', 9)", [gardens]))).rejects.toThrow(/permission denied/);
  });
});
