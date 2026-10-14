import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createUser, defaultCompany, nextPhone, one, rows, type Db } from "./harness";

let db: Db;
let hub: string, gardens: string, sph: string;
let owner: string, adminHub: string, adminGardens: string;
let account: string, promos: string, clientCategory: string;

const map = (user: string, company: string, category: string | null) =>
  asUser(db, user, (tx) => tx.query("select public.set_company_ad_category($1, $2, $3)", [account, company, category]));
const fixedOf = async (company: string) =>
  (await rows<{ id: string; name: string }>(db,
    "select id, name from public.ad_categories where ad_account_id = $1 and company_id = $2 and archived_at is null", [account, company]));

type Ingest = { state: string; lead_id?: string; owner_id?: string; company_id?: string };
let n = 0;
const ingest = (campaign: string | null, phone = nextPhone()) => asService(db, async (tx) => (await one<{ r: Ingest }>(tx,
  "select public.ingest_meta_lead(p_company_id => $1, p_leadgen_id => $2, p_name => 'Ad lead', p_phone => $3, p_phone_normalized => $3, p_form_name => 'Enquiry', p_campaign_id => $4) as r",
  [hub, `map-${++n}`, phone, campaign])).r);
const companyOf = async (lead: string) => (await one<{ company_id: string }>(db, "select company_id from public.leads where id = $1", [lead])).company_id;

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  gardens = await createCompany(db, "Star Gardens");
  sph = await createCompany(db, "Star Production House");
  owner = await createUser(db, "map_owner", "super_admin");
  adminHub = await createUser(db, "map_admin_hub", "admin", "Admin Hub");
  adminGardens = await createUser(db, "map_admin_gardens", "admin", "Admin Gardens", gardens);
  account = await asUser(db, adminHub, async (tx) =>
    (await one<{ id: string }>(tx, "select public.save_ad_account('company', $1, 'act_5551234', '777000111', 'app-secret', 'token') as id", [hub])).id);
  await asService(db, (tx) => tx.query("select public.upsert_ad_entities($1, $2, '[]')", [account, JSON.stringify([
    { meta_id: "cmp-garden-promo", name: "Villa garden promo", effective_status: "ACTIVE", created_time: "2026-09-01T10:00:00Z" },
    { meta_id: "cmp-hub", name: "Our own leads", effective_status: "ACTIVE", created_time: "2026-09-01T10:00:00Z" },
  ])]));
  await asUser(db, owner, (tx) => tx.query("select public.merge_ad_account($1, $2::uuid[])", [account, [gardens]]));
  promos = (await one<{ id: string }>(db, "insert into public.ad_categories (ad_account_id, name) values ($1, 'Garden promos') returning id", [account])).id;
  await db.query("update public.ad_campaigns set category_id = $1 where meta_id = 'cmp-garden-promo'", [promos]);
  const client = await asUser(db, adminHub, async (tx) => (await one<{ id: string }>(tx, "select public.create_ads_client('Ashok') as id")).id);
  clientCategory = (await one<{ id: string }>(db,
    "insert into public.ad_categories (ad_account_id, name, ads_client_id) values ($1, 'Ashok', $2) returning id", [account, client])).id;
});

describe("mapping a merged company to a category", () => {
  it("is for the super admin, and only for companies that share the account", async () => {
    await expect(map(adminHub, gardens, promos)).rejects.toThrow(/forbidden/);
    await expect(map(owner, sph, promos)).rejects.toThrow(/not_found/);
    await expect(map(owner, gardens, clientCategory)).rejects.toThrow(/category_in_use/);
  });

  it("moves the company to the chosen category; the old one stays as an ordinary category", async () => {
    const [before] = await fixedOf(gardens);
    expect(before.name).toBe("Star Gardens");
    await map(owner, gardens, promos);
    expect((await fixedOf(gardens)).map((c) => c.id)).toEqual([promos]);
    const old = await one<{ company_id: string | null; archived_at: string | null }>(db, "select company_id, archived_at from public.ad_categories where id = $1", [before.id]);
    expect(old).toEqual({ company_id: null, archived_at: null });
    // The overview lists the account's categories for the picker.
    const ov = await asUser(db, owner, async (tx) => (await one<{ r: { company_id: string; account_categories: { id: string; company_id: string | null }[] }[] }>(tx,
      "select public.super_ads_overview() as r")).r);
    expect(ov.find((c) => c.company_id === hub)!.account_categories.find((k) => k.id === promos)!.company_id).toBe(gardens);
  });

  it("refuses another company's category", async () => {
    await asUser(db, owner, (tx) => tx.query("select public.merge_ad_account($1, $2::uuid[])", [account, [gardens, sph]]));
    await expect(map(owner, sph, promos)).rejects.toThrow(/category_in_use/);
  });
});

describe("Facebook leads from a mapped category", () => {
  it("go to that company's CRM, owned by its admin; other campaigns stay with us", async () => {
    const r = await ingest("cmp-garden-promo");
    expect(r).toMatchObject({ state: "created", company_id: gardens, owner_id: adminGardens });
    expect(await companyOf(r.lead_id!)).toBe(gardens);
    expect(await companyOf((await ingest("cmp-hub")).lead_id!)).toBe(hub);
    expect(await companyOf((await ingest(null)).lead_id!)).toBe(hub);
    expect(await companyOf((await ingest("cmp-unknown")).lead_id!)).toBe(hub);
  });

  it("a repeat phone is merged inside that company", async () => {
    const phone = nextPhone();
    const first = await ingest("cmp-garden-promo", phone);
    const again = await ingest("cmp-garden-promo", phone);
    expect(again).toMatchObject({ state: "duplicate", lead_id: first.lead_id });
  });

  it("back to the default category: the old category's leads stay with us", async () => {
    await map(owner, gardens, null);
    expect((await fixedOf(gardens)).map((c) => c.name)).toEqual(["Star Gardens"]);
    expect(await companyOf((await ingest("cmp-garden-promo")).lead_id!)).toBe(hub);
  });
});
