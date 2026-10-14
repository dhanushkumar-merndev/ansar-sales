import { beforeAll, describe, expect, it } from "vitest";
import { createDb, createLead, createUser, one, type Db } from "./harness";

let db: Db;
let admin: string;

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "notif_admin", "admin", "Notif Admin");
});

describe("deleting leads", () => {
  it("removes their bell notifications and keeps the others", async () => {
    const gone = await createLead(db, admin, { name: "Gone" });
    const kept = await createLead(db, admin, { name: "Kept" });
    for (const [lead, key] of [[gone, "a"], [kept, "b"]]) {
      await db.query("insert into public.app_notifications (recipient_id, kind, payload, dedupe_key) values ($1, 'lead_assigned', $2, $3)",
        [admin, JSON.stringify({ lead_id: lead }), `t-${key}`]);
    }
    await db.query("insert into public.app_notifications (recipient_id, kind, payload, dedupe_key) values ($1, 'test', '{}', 't-c')", [admin]);
    await db.query("delete from public.lead_activities where lead_id = $1", [gone]);
    await db.query("delete from public.leads where id = $1", [gone]);
    const left = await one<{ n: number }>(db, "select count(*)::int as n from public.app_notifications where dedupe_key like 't-%'");
    expect(left.n).toBe(2);
  });
});
