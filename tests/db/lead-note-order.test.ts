import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createLead, createUser, one, stageId, type Db } from "./harness";

let db: Db;
let admin: string, salesA: string, salesB: string;

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales_a", "sales", "Sales A");
  salesB = await createUser(db, "sales_b", "sales", "Sales B");
});

const call = (userId: string, leadId: string) =>
  asUser(db, userId, async (tx) => (await one<{ id: string }>(tx, "select public.log_call($1) as id", [leadId])).id);
const outcome = (userId: string, callId: string, o: string, note?: string) =>
  asUser(db, userId, (tx) => tx.query("select public.set_call_outcome($1, $2, $3)", [callId, o, note ?? null]));
const stageName = async (leadId: string) =>
  (await one<{ name: string }>(db, "select s.name from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = $1", [leadId])).name;
const note = (userId: string, leadId: string, body: string) =>
  asUser(db, userId, async (tx) => (await one<{ id: string }>(tx, "insert into public.lead_activities (lead_id, type, body) values ($1, 'note', $2) returning id", [leadId, body])).id);
const notes = (userId: string, leadId: string) =>
  asUser(db, userId, async (tx) => (await one<{ r: { id: string; body: string }[] }>(tx, "select public.list_lead_notes($1) as r", [leadId])).r);

describe("connected call moves New to Contacted", () => {
  it("moves only from the first stage, only when connected, and logs the stage change", async () => {
    const lead = await createLead(db, salesA, { name: "Auto contacted" });
    expect(await stageName(lead)).toBe("New");

    await outcome(salesA, await call(salesA, lead), "no_answer");
    expect(await stageName(lead)).toBe("New");

    await outcome(salesA, await call(salesA, lead), "connected", "Wants a site visit");
    expect(await stageName(lead)).toBe("Contacted");
    const change = await one<{ meta: { from: string; to: string }; actor_id: string }>(
      db, "select meta, actor_id from public.lead_activities where lead_id = $1 and type = 'status_changed'", [lead]);
    expect(change.meta).toMatchObject({ from: "New", to: "Contacted" });
    expect(change.actor_id).toBe(salesA);
  });

  it("never moves a lead back from a later stage", async () => {
    const lead = await createLead(db, salesA, { name: "Already interested" });
    const interested = await stageId(db, "Interested");
    await asUser(db, salesA, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [lead, interested]));
    await outcome(salesA, await call(salesA, lead), "connected");
    expect(await stageName(lead)).toBe("Interested");
  });
});

describe("note order", () => {
  it("lists notes and noted calls newest first, then in the saved order with new ones on top", async () => {
    const lead = await createLead(db, salesA, { name: "Ordered notes" });
    const n1 = await note(salesA, lead, "First");
    const c = await call(salesA, lead);
    await outcome(salesA, c, "busy", "Call later");
    await call(salesA, lead); // no note: not listed
    const n2 = await note(salesA, lead, "Second");
    expect((await notes(salesA, lead)).map((n) => n.id)).toEqual([n2, c, n1]);

    await asUser(db, salesA, (tx) => tx.query("select public.set_lead_note_order($1, $2::uuid[])", [lead, [n1, n2, c]]));
    expect((await notes(salesA, lead)).map((n) => n.id)).toEqual([n1, n2, c]);
    // The admin sees the same order; a new note goes on top.
    const n3 = await note(admin, lead, "Third");
    expect((await notes(admin, lead)).map((n) => n.id)).toEqual([n3, n1, n2, c]);
  });

  it("keeps out other leads' notes and refuses people without access", async () => {
    const lead = await createLead(db, salesA, { name: "Mine" });
    const other = await createLead(db, salesB, { name: "Theirs" });
    const mine = await note(salesA, lead, "Mine");
    const theirs = await note(salesB, other, "Theirs");
    await asUser(db, salesA, (tx) => tx.query("select public.set_lead_note_order($1, $2::uuid[])", [lead, [theirs, mine]]));
    expect((await one<{ ids: string[] }>(db, "select activity_ids as ids from public.lead_note_orders where lead_id = $1", [lead])).ids).toEqual([mine]);

    await expect(asUser(db, salesB, (tx) => tx.query("select public.set_lead_note_order($1, $2::uuid[])", [lead, [mine]]))).rejects.toThrow(/not_found/);
    expect(await notes(salesB, lead)).toEqual([]);
  });

  it("colours a note card, keeps it with reordering, and clears it", async () => {
    const lead = await createLead(db, salesA, { name: "Coloured notes" });
    const a = await note(salesA, lead, "A");
    const b = await note(salesA, lead, "B");
    const setColor = (userId: string, id: string, c: string | null) =>
      asUser(db, userId, (tx) => tx.query("select public.set_lead_note_color($1, $2, $3)", [lead, id, c]));
    const colors = async (userId: string) =>
      Object.fromEntries((await asUser(db, userId, async (tx) => (await one<{ r: { id: string; color: string | null }[] }>(tx, "select public.list_lead_notes($1) as r", [lead])).r)).map((n) => [n.id, n.color]));

    await setColor(salesA, a, "amber");
    await asUser(db, salesA, (tx) => tx.query("select public.set_lead_note_order($1, $2::uuid[])", [lead, [a, b]]));
    await setColor(admin, b, "blue");
    expect(await colors(salesA)).toEqual({ [a]: "amber", [b]: "blue" });

    await setColor(salesA, a, null);
    expect(await colors(salesA)).toEqual({ [a]: null, [b]: "blue" });

    await expect(setColor(salesA, b, "neon")).rejects.toThrow(/invalid_color/);
    await expect(setColor(salesB, b, "red")).rejects.toThrow(/not_found/);
  });
});
