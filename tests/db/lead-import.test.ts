import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createUser, defaultCompany, nextPhone, one, rows, type Db } from "./harness";

let db: Db;
let other: string, admin: string, admin2: string, salesA: string, salesB: string, otherAdmin: string;

type Result = { index: number; id?: string; error?: string };
type Row = Record<string, string | undefined>;
const lead = (name: string, extra: Row = {}): Row => {
  const p = nextPhone();
  return { name, phone: p, phone_normalized: p, new_niche: "Imported", ...extra };
};
const importAs = (user: string, list: Row[], allow = false) =>
  asUser(db, user, async (tx) => (await one<{ r: Result[] }>(tx, "select public.import_leads($1::jsonb, $2) as r", [JSON.stringify(list), allow])).r);
const bell = (user: string) => rows<{ kind: string; payload: { imported?: number; lead_name?: string } }>(db,
  "select kind, payload from public.app_notifications where recipient_id = $1 order by created_at, id", [user]);

beforeAll(async () => {
  db = await createDb();
  await defaultCompany(db);
  other = await createCompany(db, "Other Co");
  admin = await createUser(db, "imp_admin", "admin", "Importer");
  admin2 = await createUser(db, "imp_admin2", "admin", "Second Admin");
  salesA = await createUser(db, "imp_sales_a", "sales", "Sales A");
  salesB = await createUser(db, "imp_sales_b", "sales", "Sales B");
  otherAdmin = await createUser(db, "imp_other", "admin", "Other Admin", other);
});

describe("importing leads", () => {
  it("creates the good rows, reports the bad ones, and keeps the timeline", async () => {
    const existing = nextPhone();
    await asUser(db, admin, (tx) => tx.query(
      "select public.create_lead(p_name => 'Already here', p_phone => $1, p_phone_normalized => $1, p_new_niche => 'Imported')", [existing]));
    const res = await importAs(admin, [
      lead("Asha", { owner_id: salesA, note: "Met at the expo", company_name: "Asha Homes", email: "asha@example.com" }),
      lead("Bala", { owner_id: salesB }),
      { ...lead("Dup"), phone: existing, phone_normalized: existing },
      lead("Wrong owner", { owner_id: otherAdmin }),
      lead("Mine"),
    ]);
    expect(res.map((r) => r.error ?? "ok")).toEqual(["ok", "ok", "duplicate_phone", "invalid_owner", "ok"]);
    const asha = await one<{ owner_id: string; company_name: string; niche: string }>(db,
      "select l.owner_id, l.company_name, n.name as niche from public.leads l join public.niches n on n.id = l.niche_id where l.id = $1", [res[0].id]);
    expect(asha).toEqual({ owner_id: salesA, company_name: "Asha Homes", niche: "Imported" });
    const timeline = await rows<{ type: string }>(db, "select type::text from public.lead_activities where lead_id = $1 order by created_at, id", [res[0].id]);
    expect(timeline.map((t) => t.type)).toEqual(expect.arrayContaining(["lead_created", "note"]));
    // Imported anyway when asked.
    expect((await importAs(admin, [{ ...lead("Dup again"), phone: existing, phone_normalized: existing }], true))[0].id).toBeTruthy();
  });

  it("sends one summary per person instead of an alert per lead", async () => {
    const before = { a: (await bell(salesA)).length, admin2: (await bell(admin2)).length };
    await importAs(admin, [lead("One", { owner_id: salesA }), lead("Two", { owner_id: salesA }), lead("Three", { owner_id: salesB })]);
    const a = (await bell(salesA)).slice(before.a);
    expect(a).toEqual([{ kind: "lead_assigned", payload: expect.objectContaining({ imported: 2, actor: "Importer" }) }]);
    const other = (await bell(admin2)).slice(before.admin2);
    expect(other).toEqual([{ kind: "lead_created", payload: expect.objectContaining({ imported: 3 }) }]);
    // The importer isn't told about their own import.
    expect((await bell(admin)).some((n) => n.payload.imported)).toBe(false);
  });

  it("gives a salesperson's rows to themselves, whatever the owner column says", async () => {
    const res = await importAs(salesA, [lead("From sales", { owner_id: salesB })]);
    expect((await one<{ owner_id: string }>(db, "select owner_id from public.leads where id = $1", [res[0].id])).owner_id).toBe(salesA);
  });

  it("stays inside the caller's company and refuses more than 500 rows", async () => {
    const res = await importAs(otherAdmin, [lead("Other company lead")]);
    expect((await one<{ company_id: string }>(db, "select company_id from public.leads where id = $1", [res[0].id])).company_id).toBe(other);
    await expect(importAs(admin, Array.from({ length: 501 }, (_, i) => lead(`L${i}`)))).rejects.toThrow(/too_many_rows/);
  });

  it("tells which phones are already in this company only", async () => {
    const p = nextPhone();
    await importAs(admin, [{ ...lead("Phone check"), phone: p, phone_normalized: p }]);
    const check = (user: string) => asUser(db, user, async (tx) => (await one<{ r: string[] }>(tx, "select public.lead_phones_in_crm($1::text[]) as r", [[p, "+15550000000"]])).r);
    expect(await check(salesB)).toEqual([p]);
    expect(await check(otherAdmin)).toEqual([]);
  });
});
