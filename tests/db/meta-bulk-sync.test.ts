import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createUser, defaultCompany, nextPhone, one, rows, type Db } from "./harness";

let db: Db;
let hub: string, gardens: string, admin: string, adminGardens: string;

type Result = { leadgen_id: string; state: string; company_id?: string; owner_id?: string };
const sync = (items: Record<string, unknown>[]) => asService(db, async (tx) =>
  (await one<{ r: Result[] }>(tx, "select public.ingest_meta_leads($1, $2) as r", [hub, JSON.stringify(items)])).r);
const alerts = async (user: string) =>
  rows<{ kind: string; payload: { imported?: number; lead_id?: string } }>(db,
    "select kind, payload from public.app_notifications where recipient_id = $1 and kind = 'lead_assigned' order by created_at, id", [user]);
const row = (id: string, extra: Record<string, unknown> = {}) => {
  const phone = nextPhone();
  return { leadgen_id: id, form_id: "f1", name: `Lead ${id}`, phone, phone_normalized: phone, form_name: "FORM 2 - VILLAS - JULY 22", ...extra };
};

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  gardens = await createCompany(db, "Star Gardens");
  admin = await createUser(db, "bulk_admin", "admin", "Bulk Admin");
  adminGardens = await createUser(db, "bulk_admin_gardens", "admin", "Gardens Admin", gardens);
  const account = await asUser(db, admin, async (tx) =>
    (await one<{ id: string }>(tx, "select public.save_ad_account('company', $1, 'act_5550001', '777000444', 'app-secret', 'token') as id", [hub])).id);
  await db.query("insert into public.ad_account_members (ad_account_id, company_id) values ($1, $2)", [account, gardens]);
  const category = (await one<{ id: string }>(db,
    "insert into public.ad_categories (ad_account_id, name, company_id) values ($1, 'Gardens', $2) returning id", [account, gardens])).id;
  await asService(db, (tx) => tx.query("select public.upsert_ad_entities($1, $2, '[]')", [account, JSON.stringify([
    { meta_id: "cmp-g", name: "Garden promo", effective_status: "ACTIVE", created_time: "2026-09-01T10:00:00Z" },
  ])]));
  await db.query("update public.ad_campaigns set category_id = $1 where meta_id = 'cmp-g'", [category]);
});

describe("bulk Facebook sync", () => {
  it("saves a batch in one call, routes by category and skips what it has seen", async () => {
    const batch = [row("b1"), row("b2", { campaign_id: "cmp-g", ad_id: "ad-9" }), row("b3", { phone: "", phone_normalized: "" })];
    const first = await sync(batch);
    expect(first.map((r) => r.state)).toEqual(["created", "created", "failed"]);
    expect(first[0]).toMatchObject({ company_id: hub, owner_id: admin });
    expect(first[1]).toMatchObject({ company_id: gardens, owner_id: adminGardens });
    const lead = await one<{ source_meta: { ad_id?: string } }>(db,
      "select l.source_meta from public.leads l join public.meta_lead_events e on e.lead_id = l.id where e.leadgen_id = 'b2'");
    expect(lead.source_meta.ad_id).toBe("ad-9");

    const again = await sync(batch);
    expect(again.map((r) => r.state)).toEqual(["skipped", "skipped", "failed"]);
  });

  it("sends no alert per lead; the summary is one per owner", async () => {
    expect(await alerts(admin)).toEqual([]);
    await asService(db, (tx) => tx.query("select public.notify_meta_leads_synced($1)", [JSON.stringify({ [admin]: 1, [adminGardens]: 1 })]));
    expect((await alerts(admin)).map((a) => a.payload.imported)).toEqual([1]);
    expect((await alerts(adminGardens)).map((a) => a.payload.imported)).toEqual([1]);
  });

  it("refuses more than 100 rows, and the webhook path still alerts per lead", async () => {
    await expect(sync(Array.from({ length: 101 }, (_, i) => row(`x${i}`)))).rejects.toThrow(/invalid_input/);
    const phone = nextPhone();
    await asService(db, (tx) => tx.query(
      "select public.ingest_meta_lead(p_company_id => $1, p_leadgen_id => 'w1', p_name => 'Webhook lead', p_phone => $2, p_phone_normalized => $2)", [hub, phone]));
    expect((await alerts(admin)).filter((a) => a.payload.lead_id)).toHaveLength(1);
  });

  it("is for the server only", async () => {
    await expect(asUser(db, admin, (tx) => tx.query("select public.ingest_meta_leads(gen_random_uuid(), '[]')"))).rejects.toThrow(/permission denied/);
  });
});
