import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createLead, createUser, one, rows, type Db } from "./harness";

let db: Db;
let admin: string, salesA: string, salesB: string;

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales_a", "sales", "Sales A");
  salesB = await createUser(db, "sales_b", "sales", "Sales B");
});

const setColumns = (userId: string, table: string, hidden: string[]) =>
  asUser(db, userId, (tx) => tx.query("select public.set_table_columns($1, $2::text[])", [table, hidden]));
const myPrefs = (userId: string) =>
  asUser(db, userId, (tx) => rows<{ user_id: string; columns: Record<string, string[]> }>(tx, "select user_id, columns from public.user_table_prefs"));

describe("table columns", () => {
  it("saves each person's hidden columns per list, readable only by them", async () => {
    await setColumns(salesA, "leads", ["owner", "created"]);
    await setColumns(salesA, "follow_ups", ["phone"]);
    await setColumns(salesA, "leads", ["created"]); // replaces the leads list, keeps follow_ups
    await setColumns(admin, "leads", ["niche"]);

    expect(await myPrefs(salesA)).toEqual([{ user_id: salesA, columns: { leads: ["created"], follow_ups: ["phone"] } }]);
    expect(await myPrefs(salesB)).toEqual([]);
    expect((await myPrefs(admin)).map((p) => p.user_id)).toEqual([admin]);
  });

  it("refuses unknown lists, bad entries and direct writes", async () => {
    await expect(setColumns(salesA, "expenses", [])).rejects.toThrow(/invalid_table/);
    await expect(setColumns(salesA, "leads", [""])).rejects.toThrow(/invalid_columns/);
    await expect(setColumns(salesA, "leads", Array.from({ length: 21 }, (_, i) => `c${i}`))).rejects.toThrow(/invalid_columns/);
    await expect(asUser(db, salesB, (tx) => tx.query("insert into public.user_table_prefs (user_id) values ($1)", [salesB]))).rejects.toThrow();
    await expect(asUser(db, null, (tx) => tx.query("select public.set_table_columns('leads', '{}')"))).rejects.toThrow();
  });
});

describe("call talk time", () => {
  it("lets only the caller record it, within a day and a sane range", async () => {
    const lead = await createLead(db, salesA, { name: "Talk time" });
    const call = await asUser(db, salesA, async (tx) => (await one<{ id: string }>(tx, "select public.log_call($1) as id", [lead])).id);
    const setTime = (userId: string, seconds: number) =>
      asUser(db, userId, (tx) => tx.query("select public.set_call_duration($1, $2)", [call, seconds]));

    await setTime(salesA, 200);
    await asUser(db, salesA, (tx) => tx.query("select public.set_call_outcome($1, 'connected', 'Good chat')", [call]));
    await setTime(salesA, 215); // corrected afterwards; the outcome stays
    const meta = async () => (await one<{ meta: Record<string, unknown> }>(db, "select meta from public.lead_activities where id = $1", [call])).meta;
    // The measured time is kept and the edit is marked, so the timeline can show "edited, was 3 min 20 s".
    expect(await meta()).toMatchObject({ duration_seconds: 215, outcome: "connected", duration_measured_seconds: 200 });
    expect((await meta()).duration_edited_at).toBeTruthy();
    await setTime(salesA, 230);
    expect(await meta()).toMatchObject({ duration_seconds: 230, duration_measured_seconds: 200 });

    await expect(setTime(salesA, -1)).rejects.toThrow(/invalid_duration/);
    await expect(setTime(salesA, 86401)).rejects.toThrow(/invalid_duration/);
    await expect(setTime(admin, 10)).rejects.toThrow(/not_found/);
    await expect(setTime(salesB, 10)).rejects.toThrow(/not_found/);

    await asService(db, (tx) => tx.query("update public.lead_activities set created_at = now() - interval '25 hours' where id = $1", [call]));
    await expect(setTime(salesA, 10)).rejects.toThrow(/call_outcome_closed/);
  });
});
