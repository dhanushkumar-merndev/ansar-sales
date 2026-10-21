import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createLead, createUser, nextPhone, one, rows, stageId, type Db } from "./harness";

let db: Db;
let admin: string, salesA: string, salesB: string;

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
});

const nicheCount = async () => (await one<{ n: number }>(db, "select count(*)::int as n from public.niches")).n;

describe("transaction integrity", () => {
  it("rolls back the niche, lead and note when the initial follow-up is invalid", async () => {
    const before = await nicheCount();
    await expect(asUser(db, salesA, (tx) => tx.query(
      `select public.create_lead(p_name => 'Broken', p_phone => $1, p_phone_normalized => $1, p_new_niche => 'Brand New Niche',
         p_note => 'note', p_follow_up_at => now(), p_follow_up_task => repeat('x', 600))`, [nextPhone()]))).rejects.toThrow();
    expect(await nicheCount()).toBe(before);
    expect((await one<{ n: number }>(db, "select count(*)::int as n from public.leads where name = 'Broken'")).n).toBe(0);
  });

  it("records creation, note and follow-up activities together", async () => {
    const id = await createLead(db, salesA, { name: "Beta", note: "Interested in plan B", followUpAt: "2099-03-01T04:30:00Z" });
    const types = await asUser(db, salesA, (tx) => rows<{ type: string; actor_id: string }>(tx,
      "select type, actor_id from public.lead_activities where lead_id = $1 order by type", [id]));
    expect(types.map((t) => t.type).sort()).toEqual(["follow_up_scheduled", "lead_created", "note"]);
    expect(new Set(types.map((t) => t.actor_id))).toEqual(new Set([salesA]));
  });

  it("logs status changes and field edits with readable old/new values", async () => {
    const id = await createLead(db, salesA, { name: "Gamma", niche: "Retail" });
    const contacted = await stageId(db, "Contacted");
    await asUser(db, salesA, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [id, contacted]));
    const v = (await one<{ version: number }>(db, "select version from public.leads where id = $1", [id])).version;
    await asUser(db, salesA, (tx) => tx.query(
      "select public.update_lead($1, $2, 'Gamma Ltd', '+91 90000 11111', '+919000011111', 'a@b.co', null, 'Education')", [id, v]));
    const acts = await rows<{ type: string; meta: Record<string, unknown> }>(db,
      "select type, meta from public.lead_activities where lead_id = $1 and type in ('status_changed', 'lead_updated') order by created_at, type", [id]);
    expect(acts[0]).toEqual({ type: "status_changed", meta: {
      from: "New", to: "Contacted", from_kind: "open", to_kind: "open", from_stage_id: await stageId(db, "New"), to_stage_id: contacted,
    } });
    expect(acts[1].meta).toEqual({ changes: {
      Name: { from: "Gamma", to: "Gamma Ltd" },
      Phone: { from: expect.any(String), to: "+91 90000 11111" },
      Email: { from: null, to: "a@b.co" },
      Niche: { from: "Retail", to: "Education" },
    } });
  });

  it("keeps an optional company name: created, edited with history, searchable", async () => {
    const phone = nextPhone();
    const id = await asUser(db, salesA, async (tx) => (await one<{ id: string }>(tx,
      `select public.create_lead(p_name => 'Ravi', p_phone => $1, p_phone_normalized => $1, p_new_niche => 'Retail',
         p_company_name => '  Ravi   Traders ') as id`, [phone])).id);
    expect(await one(db, "select company_name from public.leads where id = $1", [id])).toEqual({ company_name: "Ravi Traders" });

    const v = (await one<{ version: number }>(db, "select version from public.leads where id = $1", [id])).version;
    await asUser(db, salesA, (tx) => tx.query(
      "select public.update_lead($1, $2, 'Ravi', $3, $3, null, null, 'Retail', p_company_name => 'Ravi Exports')", [id, v, phone]));
    const act = await one<{ meta: { changes: Record<string, unknown> } }>(db,
      "select meta from public.lead_activities where lead_id = $1 and type = 'lead_updated' order by created_at desc limit 1", [id]);
    expect(act.meta.changes).toEqual({ Company: { from: "Ravi Traders", to: "Ravi Exports" } });

    const found = await asUser(db, salesA, async (tx) => (await one<{ r: { items: { id: string; company_name: string }[] } }>(tx,
      "select public.list_leads(p_search => 'exports') as r")).r);
    expect(found.items).toEqual([expect.objectContaining({ id, company_name: "Ravi Exports" })]);
    // Sales B can't find it by company either (RLS).
    const other = await asUser(db, salesB, async (tx) => (await one<{ r: { items: unknown[] } }>(tx, "select public.list_leads(p_search => 'exports') as r")).r);
    expect(other.items).toEqual([]);
  });

  it("sets a lead's temperature with history, filters on it, and keeps Sales to their own leads", async () => {
    const id = await createLead(db, salesA, { name: "Warmth" });
    await asUser(db, salesB, (tx) => tx.query("update public.leads set temperature = 'hot' where id = $1", [id]));
    expect(await one(db, "select temperature from public.leads where id = $1", [id])).toEqual({ temperature: null });

    await asUser(db, salesA, (tx) => tx.query("update public.leads set temperature = 'hot' where id = $1", [id]));
    await asUser(db, salesA, (tx) => tx.query("update public.leads set temperature = 'cold' where id = $1", [id]));
    const acts = await rows<{ meta: { changes: Record<string, unknown> } }>(db,
      "select meta from public.lead_activities where lead_id = $1 and type = 'lead_updated' order by created_at", [id]);
    expect(acts.map((a) => a.meta.changes)).toEqual([
      { Temperature: { from: null, to: "Hot" } },
      { Temperature: { from: "Hot", to: "Cold" } },
    ]);

    const list = (temperature: string) => asUser(db, salesA, async (tx) => (await one<{ r: { items: { id: string; temperature: string }[] } }>(tx,
      "select public.list_leads(p_limit => 100, p_temperature => $1::public.lead_temperature) as r", [temperature])).r.items);
    expect(await list("cold")).toEqual([expect.objectContaining({ id, temperature: "cold" })]);
    expect((await list("hot")).map((l) => l.id)).not.toContain(id);
  });

  it("flags edit conflicts instead of overwriting", async () => {
    const id = await createLead(db, salesA, { name: "Delta" });
    const interested = await stageId(db, "Interested");
    const v = (await one<{ version: number }>(db, "select version from public.leads where id = $1", [id])).version;
    await asUser(db, admin, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [id, interested]));
    await expect(asUser(db, salesA, (tx) => tx.query(
      "select public.update_lead($1, $2, 'Delta 2', '+919999999999', '+919999999999', null, null, 'Retail')", [id, v]))).rejects.toThrow(/version_conflict/);
    // Must not be a retryable SQLSTATE (40001/40P01): PostgREST re-runs those transactions until the gateway times out.
    await expect(asUser(db, salesA, (tx) => tx.query(
      "select public.update_lead($1, $2, 'Delta 2', '+919999999999', '+919999999999', null, null, 'Retail')", [id, v]))).rejects.toMatchObject({ code: "PT409" });
  });

  it("keeps note history when a note is corrected", async () => {
    const id = await createLead(db, salesA, { name: "Epsilon", note: "Budget 5L" });
    const note = await one<{ id: string }>(db, "select id from public.lead_activities where lead_id = $1 and type = 'note'", [id]);
    await asUser(db, salesA, (tx) => tx.query("select public.correct_note($1, 'Budget 50L')", [note.id]));
    const all = await rows<{ type: string; body: string | null; meta: Record<string, unknown>; edited: boolean }>(db,
      "select type, body, meta, edited_at is not null as edited from public.lead_activities where lead_id = $1 and type in ('note', 'note_corrected') order by type", [id]);
    expect(all).toEqual([
      { type: "note", body: "Budget 50L", meta: {}, edited: true },
      { type: "note_corrected", body: null, meta: { note_id: note.id, previous_body: "Budget 5L" }, edited: false },
    ]);
    await expect(asUser(db, salesB, (tx) => tx.query("select public.correct_note($1, 'x')", [note.id]))).rejects.toThrow(/not_found/);
  });

  it("completes a follow-up and schedules the next one atomically", async () => {
    const id = await createLead(db, salesA, { name: "Zeta", followUpAt: "2099-01-01T00:00:00Z" });
    const fu = await one<{ id: string }>(db, "select id from public.follow_ups where lead_id = $1", [id]);
    await asUser(db, salesA, (tx) => tx.query("select public.complete_follow_up($1, 'Spoke to owner', '2099-02-01T00:00:00Z', 'Send proposal')", [fu.id]));
    const fus = await rows<{ state: string; task: string; completed_by: string | null }>(db,
      "select state, task, completed_by from public.follow_ups where lead_id = $1 order by created_at, state", [id]);
    expect(fus).toEqual(expect.arrayContaining([
      { state: "completed", task: "Follow up", completed_by: salesA },
      { state: "pending", task: "Send proposal", completed_by: null },
    ]));
    await expect(asUser(db, salesA, (tx) => tx.query("select public.complete_follow_up($1, 'again')", [fu.id]))).rejects.toThrow(/not_found_or_closed/);
    await expect(asUser(db, salesA, (tx) => tx.query("update public.follow_ups set task = 'edit' where id = $1", [fu.id]))).rejects.toThrow(/follow_up_closed/);
  });
});

describe("niches", () => {
  it("normalizes case and whitespace so one option exists", async () => {
    await createLead(db, salesA, { niche: "  Real   Estate " });
    await createLead(db, salesB, { niche: "real estate" });
    const list = await rows<{ name: string }>(db, "select name from public.niches where normalized_name = 'real estate'");
    expect(list).toEqual([{ name: "Real Estate" }]);
    // The unique constraint is the final guard for concurrent saves.
    await expect(db.query("insert into public.niches (name, company_id) select 'REAL ESTATE', id from public.companies order by created_at limit 1"))
      .rejects.toThrow(/niches_company_normalized_name_key/);
  });

  it("a niche created by one sales user is visible to other lead users", async () => {
    await createLead(db, salesA, { niche: "Hospitality" });
    const seen = await asUser(db, salesB, (tx) => rows(tx, "select id from public.niches where normalized_name = 'hospitality'"));
    expect(seen).toHaveLength(1);
  });

  it("merge keeps lead references valid and redirects future saves", async () => {
    const leadId = await createLead(db, salesA, { niche: "Edtech" });
    const src = await one<{ id: string }>(db, "select id from public.niches where normalized_name = 'edtech'");
    const target = await one<{ id: string }>(db, "select id from public.niches where normalized_name = 'education'");
    await expect(asUser(db, salesA, (tx) => tx.query("select public.merge_niches($1, $2)", [src.id, target.id]))).rejects.toThrow(/forbidden/);
    await asUser(db, admin, (tx) => tx.query("select public.merge_niches($1, $2)", [src.id, target.id]));
    expect((await one<{ niche_id: string }>(db, "select niche_id from public.leads where id = $1", [leadId])).niche_id).toBe(target.id);
    const again = await createLead(db, salesB, { niche: "EDTECH" });
    expect((await one<{ niche_id: string }>(db, "select niche_id from public.leads where id = $1", [again])).niche_id).toBe(target.id);
  });

  it("archived niches cannot be reused for new leads", async () => {
    await createLead(db, salesA, { niche: "Old Niche" });
    await asUser(db, admin, (tx) => tx.query("update public.niches set archived_at = now() where normalized_name = 'old niche'"));
    await expect(createLead(db, salesA, { niche: "old niche" })).rejects.toThrow(/niche_archived/);
    await expect(asUser(db, salesA, (tx) => tx.query("update public.niches set name = 'x' where normalized_name = 'retail'"))).resolves.toMatchObject({ affectedRows: 0 });
  });
});
