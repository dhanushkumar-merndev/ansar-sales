import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createUser, defaultCompany, nextPhone, one, rows, type Db } from "./harness";

let db: Db;
let hub: string, gardens: string, quiet: string;
let owner: string, adminHub: string, adminGardens: string;
let account: string, villas: string, lawns: string, clientCategory: string;

const setCategories = (user: string, company: string, ids: string[]) =>
  asUser(db, user, (tx) => tx.query("select public.set_company_ad_categories($1, $2, $3::uuid[])", [account, company, ids]));
const mappedTo = async (company: string) =>
  (await rows<{ name: string }>(db,
    "select name from public.ad_categories where ad_account_id = $1 and company_id = $2 and archived_at is null order by name", [account, company]))
    .map((k) => k.name);

let n = 0;
const companyOfLead = (campaign: string) => asService(db, async (tx) => (await one<{ r: { company_id: string } }>(tx,
  "select public.ingest_meta_lead(p_company_id => $1, p_leadgen_id => $2, p_name => 'Ad lead', p_phone => $3, p_phone_normalized => $3, p_form_name => 'Enquiry', p_campaign_id => $4) as r",
  [hub, `cats-${++n}`, nextPhone(), campaign])).r.company_id);
const category = async (name: string, client: string | null = null) =>
  (await one<{ id: string }>(db, "insert into public.ad_categories (ad_account_id, name, ads_client_id) values ($1, $2, $3) returning id", [account, name, client])).id;

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  gardens = await createCompany(db, "Star Gardens");
  quiet = await createCompany(db, "Quiet Co");
  owner = await createUser(db, "cats_owner", "super_admin");
  adminHub = await createUser(db, "cats_admin_hub", "admin", "Admin Hub");
  adminGardens = await createUser(db, "cats_admin_gardens", "admin", "Admin Gardens", gardens);
  account = await asUser(db, adminHub, async (tx) =>
    (await one<{ id: string }>(tx, "select public.save_ad_account('company', $1, 'act_5559999', '777000222', 'app-secret', 'token') as id", [hub])).id);
  await asService(db, (tx) => tx.query("select public.upsert_ad_entities($1, $2, '[]')", [account, JSON.stringify([
    { meta_id: "cmp-villas", name: "Villa promo", effective_status: "ACTIVE", created_time: "2026-09-01T10:00:00Z" },
    { meta_id: "cmp-lawns", name: "Lawn promo", effective_status: "ACTIVE", created_time: "2026-09-01T10:00:00Z" },
    { meta_id: "cmp-hub", name: "Our own leads", effective_status: "ACTIVE", created_time: "2026-09-01T10:00:00Z" },
  ])]));
  villas = await category("Villas");
  lawns = await category("Lawns");
  const client = await asUser(db, adminHub, async (tx) => (await one<{ id: string }>(tx, "select public.create_ads_client('Ashok') as id")).id);
  clientCategory = await category("Ashok", client);
  await db.query("update public.ad_campaigns set category_id = $1 where meta_id = 'cmp-villas'", [villas]);
  await db.query("update public.ad_campaigns set category_id = $1 where meta_id = 'cmp-lawns'", [lawns]);
});

describe("several categories for one company", () => {
  it("is for the super admin only", async () => {
    await expect(setCategories(adminHub, gardens, [villas])).rejects.toThrow(/forbidden/);
  });

  it("joins the shared account and sends leads of every ticked category to the company", async () => {
    expect(await rows(db, "select 1 from public.ad_account_members where company_id = $1", [gardens])).toHaveLength(0);
    await setCategories(owner, gardens, [villas, lawns]);
    expect(await rows(db, "select 1 from public.ad_account_members where ad_account_id = $1 and company_id = $2", [account, gardens])).toHaveLength(1);
    expect(await mappedTo(gardens)).toEqual(["Lawns", "Villas"]);
    expect(await companyOfLead("cmp-villas")).toBe(gardens);
    expect(await companyOfLead("cmp-lawns")).toBe(gardens);
    expect(await companyOfLead("cmp-hub")).toBe(hub);
  });

  it("shows the company the campaigns of all its categories", async () => {
    const page = await asUser(db, adminGardens, async (tx) => (await one<{ r: { items: { name: string }[] } }>(tx,
      "select public.list_ad_campaigns($1, current_date - 60, current_date) as r", [account])).r);
    expect(page.items.map((c) => c.name).sort()).toEqual(["Lawn promo", "Villa promo"]);
  });

  it("unticking one sends its leads back to us and keeps its campaigns", async () => {
    await setCategories(owner, gardens, [villas]);
    expect(await mappedTo(gardens)).toEqual(["Villas"]);
    expect(await companyOfLead("cmp-lawns")).toBe(hub);
    expect((await one<{ category_id: string }>(db, "select category_id from public.ad_campaigns where meta_id = 'cmp-lawns'")).category_id).toBe(lawns);
  });

  it("refuses a client's or another company's category, the owner, and a company on another account", async () => {
    await expect(setCategories(owner, gardens, [clientCategory])).rejects.toThrow(/category_in_use/);
    await expect(setCategories(owner, quiet, [villas])).rejects.toThrow(/category_in_use/);
    await expect(setCategories(owner, hub, [lawns])).rejects.toThrow(/not_found/);

    const other = await createCompany(db, "Other Co");
    const adminOther = await createUser(db, "cats_admin_other", "admin", "Admin Other", other);
    const otherAccount = await asUser(db, adminOther, async (tx) =>
      (await one<{ id: string }>(tx, "select public.save_ad_account('company', $1, 'act_5550000', '777000333', 'app-secret', 'token') as id", [other])).id);
    await asUser(db, owner, (tx) => tx.query("select public.merge_ad_account($1, $2::uuid[])", [otherAccount, [quiet]]));
    await expect(setCategories(owner, quiet, [lawns])).rejects.toThrow(/already_merged/);
  });

  it("the overview names who has each category", async () => {
    const ov = await asUser(db, owner, async (tx) => (await one<{ r: { company_id: string; account_categories: { id: string; company_name: string | null; client_name: string | null }[] }[] }>(tx,
      "select public.super_ads_overview() as r")).r);
    const cats = ov.find((c) => c.company_id === hub)!.account_categories;
    expect(cats.find((k) => k.id === villas)).toMatchObject({ company_name: "Star Gardens", client_name: null });
    expect(cats.find((k) => k.id === clientCategory)).toMatchObject({ company_name: null, client_name: "Ashok" });
  });
});
