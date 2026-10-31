import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createLead, createUser, one, rows, stageId, type Db } from "./harness";

// 20261008005300_call_wrap_up: the call screen's Save (finish_call) and admins correcting talk time.

let db: Db;
let admin: string, salesA: string, salesB: string;

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales_a", "sales", "Sales A");
  salesB = await createUser(db, "sales_b", "sales", "Sales B");
});

const logCall = (user: string, lead: string) =>
  asUser(db, user, async (tx) => (await one<{ id: string }>(tx, "select public.log_call($1) as id", [lead])).id);

type Finish = { outcome?: string; note?: string | null; stage?: string | null; setTemperature?: boolean; temperature?: string | null };
const finish = (user: string, call: string, f: Finish = {}) =>
  asUser(db, user, (tx) =>
    tx.query("select public.finish_call($1, $2, $3, $4, $5, $6::public.lead_temperature)", [
      call, f.outcome ?? "connected", f.note ?? null, f.stage ?? null, f.setTemperature ?? false, f.temperature ?? null,
    ]),
  );

/** The lead's history, newest first, as the timeline reads it. */
const history = (lead: string) =>
  rows<{ type: string; body: string | null; meta: Record<string, unknown> }>(db,
    "select type, body, meta from public.lead_activities where lead_id = $1 order by created_at desc, id desc", [lead]);

const lead = (id: string) =>
  one<{ stage: string; temperature: string | null }>(db,
    "select s.name as stage, l.temperature::text as temperature from public.leads l join public.pipeline_stages s on s.id = l.stage_id where l.id = $1", [id]);

describe("finish_call", () => {
  it("saves the call, then the status, then the temperature, in that order", async () => {
    const id = await createLead(db, salesA, { name: "Wrap up" });
    const call = await logCall(salesA, id);
    await finish(salesA, call, { note: "Wants 2 plots", stage: await stageId(db, "Interested"), setTemperature: true, temperature: "hot" });

    expect(await lead(id)).toEqual({ stage: "Interested", temperature: "hot" });
    const [temp, status, called, created] = await history(id);
    expect(temp).toMatchObject({ type: "lead_updated", meta: { changes: { Temperature: { from: null, to: "Hot" } } } });
    // Picked straight from New: no automatic Contacted step in between.
    expect(status).toMatchObject({ type: "status_changed", meta: { from: "New", to: "Interested" } });
    expect(called).toMatchObject({ type: "call_logged", body: "Wants 2 plots", meta: { outcome: "connected" } });
    expect(created.type).toBe("lead_created");
  });

  it("leaves status and temperature alone when not picked (a connected call still moves New to Contacted)", async () => {
    const id = await createLead(db, salesA);
    await asUser(db, salesA, (tx) => tx.query("update public.leads set temperature = 'cold' where id = $1", [id]));
    await finish(salesA, await logCall(salesA, id));
    expect(await lead(id)).toEqual({ stage: "Contacted", temperature: "cold" });

    const other = await createLead(db, salesA);
    await finish(salesA, await logCall(salesA, other), { outcome: "no_answer" });
    expect(await lead(other)).toEqual({ stage: "New", temperature: null });
    expect((await history(other)).map((a) => a.type)).toEqual(["call_logged", "lead_created"]);
  });

  it("clears the temperature, and writes nothing for an unchanged status", async () => {
    const id = await createLead(db, salesA);
    await asUser(db, salesA, (tx) => tx.query("update public.leads set temperature = 'medium' where id = $1", [id]));
    await finish(salesA, await logCall(salesA, id), { outcome: "busy", stage: await stageId(db, "New"), setTemperature: true, temperature: null });
    expect(await lead(id)).toEqual({ stage: "New", temperature: null });
    expect((await history(id)).filter((a) => a.type === "status_changed")).toEqual([]);
  });

  it("saves nothing when any part is refused", async () => {
    const id = await createLead(db, salesA);
    const call = await logCall(salesA, id);
    // Someone else's lead.
    await expect(finish(salesB, call, { stage: await stageId(db, "Interested") })).rejects.toThrow(/not_found/);
    // Another company's stage.
    const farm = await createCompany(db, "Farm");
    await asService(db, (tx) => tx.query("insert into public.pipeline_stages (company_id, name, kind, position) values ($1, 'Farm stage', 'open', 1)", [farm]));
    await expect(finish(salesA, call, { stage: await stageId(db, "Farm stage", farm), note: "x" })).rejects.toThrow(/invalid_stage/);
    // Bad outcome after a valid status: the status change is rolled back too.
    await expect(finish(salesA, call, { outcome: "maybe", stage: await stageId(db, "Interested") })).rejects.toThrow(/invalid_outcome/);

    expect(await lead(id)).toEqual({ stage: "New", temperature: null });
    expect((await history(id)).map((a) => [a.type, a.meta.outcome ?? null])).toEqual([["call_logged", null], ["lead_created", null]]);
  });

  it("an admin can't save the result of someone else's call", async () => {
    const id = await createLead(db, salesA);
    const call = await logCall(salesA, id);
    await expect(finish(admin, call)).rejects.toThrow(/not_found/);
  });
});

describe("talk time edits", () => {
  const meta = async (call: string) => (await one<{ meta: Record<string, unknown> }>(db, "select meta from public.lead_activities where id = $1", [call])).meta;
  const setTime = (user: string, call: string, seconds: number) =>
    asUser(db, user, (tx) => tx.query("select public.set_call_duration($1, $2)", [call, seconds]));

  it("lets an admin correct anyone's call at any age, and records who did", async () => {
    const id = await createLead(db, salesA);
    const call = await logCall(salesA, id);
    await setTime(salesA, call, 110);
    await asService(db, (tx) => tx.query("update public.lead_activities set created_at = now() - interval '3 days' where id = $1", [call]));

    await setTime(admin, call, 95);
    expect(await meta(call)).toMatchObject({ duration_seconds: 95, duration_measured_seconds: 110, duration_edited_by: "Admin" });
    expect((await meta(call)).duration_edited_at).toBeTruthy();
  });

  it("marks an admin's time on a call that had none, without a measured time", async () => {
    const call = await logCall(salesA, await createLead(db, salesA));
    await setTime(admin, call, 60);
    const m = await meta(call);
    expect(m).toMatchObject({ duration_seconds: 60, duration_edited_by: "Admin" });
    expect(m).not.toHaveProperty("duration_measured_seconds");
  });

  it("keeps Sales to their own call within a day", async () => {
    const id = await createLead(db, salesA);
    const call = await logCall(salesA, id);
    await setTime(salesA, call, 40);
    expect(await meta(call)).not.toHaveProperty("duration_edited_at"); // the caller's first time is the measured one
    await expect(setTime(salesB, call, 10)).rejects.toThrow(/not_found/);
    await asService(db, (tx) => tx.query("update public.lead_activities set created_at = now() - interval '25 hours' where id = $1", [call]));
    await expect(setTime(salesA, call, 10)).rejects.toThrow(/call_outcome_closed/);
  });
});
