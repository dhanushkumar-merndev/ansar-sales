import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createLead, createUser, nextPhone, one, rows, type Db } from "./harness";

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
    await asUser(db, salesA, (tx) => tx.query("update public.leads set status = 'contacted' where id = $1", [id]));
    const v = (await one<{ version: number }>(db, "select version from public.leads where id = $1", [id])).version;
    await asUser(db, salesA, (tx) => tx.query(
      "select public.update_lead($1, $2, 'Gamma Ltd', '+91 90000 11111', '+919000011111', 'a@b.co', null, 'Education')", [id, v]));
    const acts = await rows<{ type: string; meta: Record<string, unknown> }>(db,
      "select type, meta from public.lead_activities where lead_id = $1 and type in ('status_changed', 'lead_updated') order by created_at, type", [id]);
    expect(acts[0]).toEqual({ type: "status_changed", meta: { from: "new", to: "contacted" } });
    expect(acts[1].meta).toEqual({ changes: {
      Name: { from: "Gamma", to: "Gamma Ltd" },
      Phone: { from: expect.any(String), to: "+91 90000 11111" },
      Email: { from: null, to: "a@b.co" },
      Niche: { from: "Retail", to: "Education" },
    } });
  });

  it("flags edit conflicts instead of overwriting", async () => {
    const id = await createLead(db, salesA, { name: "Delta" });
    const v = (await one<{ version: number }>(db, "select version from public.leads where id = $1", [id])).version;
    await asUser(db, admin, (tx) => tx.query("update public.leads set status = 'interested' where id = $1", [id]));
    await expect(asUser(db, salesA, (tx) => tx.query(
      "select public.update_lead($1, $2, 'Delta 2', '+919999999999', '+919999999999', null, null, 'Retail')", [id, v]))).rejects.toThrow(/version_conflict/);
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
    await expect(db.query("insert into public.niches (name) values ('REAL ESTATE')")).rejects.toThrow(/niches_normalized_name_key/);
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
