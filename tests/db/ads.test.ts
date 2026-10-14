import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createLead, createUser, defaultCompany, one, rows, stageId, type Db } from "./harness";

let db: Db;
let hub: string, sph: string, gardens: string;
let owner: string, adminHub: string, salesHub: string, accountHub: string, adminSph: string, adminGardens: string;
let adsMgr: string, adsMgrSph: string, adsMgrNone: string;
let account: string;

type Overview = {
  account: Record<string, unknown>; totals: Record<string, number>; reach_month: number | null;
  daily: { date: string; spend: number }[]; campaigns: { name: string; spend: number }[]; categories: { name: string; spend: number }[] | null;
};
type Page = { items: { name: string; spend: number; category: { name: string } | null }[]; total: number };

const overview = (user: string, acc = account, from = "2026-09-01", to = "2026-09-30") =>
  asUser(db, user, async (tx) => (await one<{ r: Overview }>(tx, "select public.ads_overview($1, $2::date, $3::date) as r", [acc, from, to])).r);
const campaigns = (user: string, acc = account, extra = "") =>
  asUser(db, user, async (tx) => (await one<{ r: Page }>(tx, `select public.list_ad_campaigns($1, '2026-09-01', '2026-09-30'${extra}) as r`, [acc])).r);
const moveTo = (user: string, lead: string, stage: string) =>
  asUser(db, user, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [lead, stage]));
const switchTo = (user: string, company: string) => asUser(db, user, (tx) => tx.query("select public.set_active_company($1)", [company]));

const insight = (campaign: string, date: string, spend: number, extra: Record<string, unknown> = {}) => ({
  campaign_meta_id: campaign, date, spend, impressions: 1000, reach: 800, clicks: 50, link_clicks: 40, leads: 5, conversions: 0, conversion_value: 0, ...extra,
});

async function seedAccountData(acc: string, prefix: string) {
  await asService(db, async (tx) => {
    await tx.query("select public.set_ad_account_state($1, 'connected', null, 'Main account', 'INR', 'Asia/Kolkata')", [acc]);
    await tx.query("select public.upsert_ad_entities($1, $2, $3)", [acc,
      JSON.stringify([
        { meta_id: `${prefix}1`, name: "SGH leads October", effective_status: "ACTIVE", created_time: "2026-08-20T10:00:00Z" },
        { meta_id: `${prefix}2`, name: "SPH reel promo", effective_status: "ACTIVE", created_time: "2026-08-25T10:00:00Z" },
        { meta_id: `${prefix}3`, name: "Brand awareness", effective_status: "PAUSED", created_time: "2026-07-01T10:00:00Z" },
      ]),
      JSON.stringify([
        { meta_id: `${prefix}a1`, campaign_meta_id: `${prefix}1`, name: "Carousel A", created_time: "2026-08-21T10:00:00Z", thumbnail_url: "https://x/1.jpg" },
        { meta_id: `${prefix}a2`, campaign_meta_id: `${prefix}1`, name: "Video B", created_time: "2026-09-02T10:00:00Z" },
      ])]);
    const days = [
      insight(`${prefix}1`, "2026-09-01", 1000.5), insight(`${prefix}1`, "2026-09-02", 999.5),
      insight(`${prefix}2`, "2026-09-01", 300), insight(`${prefix}3`, "2026-09-02", 200, { leads: 0 }),
    ];
    await tx.query("select public.upsert_ad_insights($1, 'campaign', $2)", [acc, JSON.stringify(days)]);
    await tx.query("select public.upsert_ad_insights($1, 'ad', $2)", [acc, JSON.stringify([
      { ...insight(`${prefix}1`, "2026-09-01", 600), ad_meta_id: `${prefix}a1` },
      { ...insight(`${prefix}1`, "2026-09-02", 999.5), ad_meta_id: `${prefix}a2` },
    ])]);
  });
}

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  sph = await createCompany(db, "Star Production House");
  gardens = await createCompany(db, "Star Gardens");
  owner = await createUser(db, "owner", "super_admin");
  adminHub = await createUser(db, "admin_hub", "admin", "Admin Hub");
  salesHub = await createUser(db, "sales_hub", "sales", "Sales Hub");
  accountHub = await createUser(db, "account_hub", "account", "Account Hub");
  adminSph = await createUser(db, "admin_sph", "admin", "Admin SPH", sph);
  adminGardens = await createUser(db, "admin_gardens", "admin", "Admin Gardens", gardens);
  adsMgr = await createUser(db, "ads_mgr", "ads_manager", "Ads Manager");
  adsMgrSph = await createUser(db, "ads_mgr_sph", "ads_manager", "Ads SPH");
  adsMgrNone = await createUser(db, "ads_mgr_none", "ads_manager", "Ads Nobody");
  await asUser(db, owner, async (tx) => {
    await tx.query("select public.set_ads_manager_companies($1, $2::uuid[])", [adsMgr, [hub, sph]]);
    await tx.query("select public.set_ads_manager_companies($1, $2::uuid[])", [adsMgrSph, [sph]]);
  });

  account = await asUser(db, adminHub, async (tx) =>
    (await one<{ id: string }>(tx, "select public.save_ad_account('company', $1, 'act_1234567', '111111', 'app-secret-x', 'token-x') as id", [hub])).id);
  await seedAccountData(account, "c");
  await asUser(db, owner, (tx) => tx.query("select public.merge_ad_account($1, $2::uuid[])", [account, [sph]]));
  const sphCategory = (await one<{ id: string }>(db, "select id from public.ad_categories where ad_account_id = $1 and company_id = $2", [account, sph])).id;
  await asUser(db, adsMgr, (tx) => tx.query("select public.save_ad_category($1, $2, 'ignored', 'SPH')", [account, sphCategory]));
});

describe("ad account data", () => {
  it("totals are exact and re-syncing the same days does not double them", async () => {
    const o = await overview(adminHub);
    expect(Number(o.totals.spend)).toBe(2500);
    expect(Number(o.totals.leads)).toBe(15);
    expect(Number(o.totals.impressions)).toBe(4000);
    expect(o.daily).toHaveLength(30);
    expect(o.campaigns[0]).toMatchObject({ name: "SGH leads October" });
    expect(Number(o.campaigns[0].spend)).toBe(2000);

    await asService(db, (tx) => tx.query("select public.upsert_ad_insights($1, 'campaign', $2)", [account, JSON.stringify([insight("c1", "2026-09-01", 1000.5)])]));
    expect(Number((await overview(adminHub)).totals.spend)).toBe(2500);
  });

  it("keeps secrets and sync functions server-only", async () => {
    const detail = await asUser(db, adminHub, async (tx) => (await one<{ r: unknown }>(tx, "select public.ad_account_detail($1) as r", [account])).r);
    expect(JSON.stringify(detail)).not.toMatch(/app-secret-x|token-x/);
    await expect(asUser(db, adminHub, (tx) => tx.query("select * from public.ad_account_secrets($1)", [account]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.upsert_ad_insights($1, 'campaign', '[]')", [account]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, adminHub, (tx) => tx.query("select * from public.ad_campaign_daily"))).rejects.toThrow(/permission denied/);
    const secrets = await asService(db, (tx) => one<{ app_secret: string; access_token: string }>(tx, "select * from public.ad_account_secrets($1)", [account]));
    expect(secrets).toMatchObject({ app_secret: "app-secret-x", access_token: "token-x" });
  });

  it("refuses connecting the same Meta ad account twice", async () => {
    await expect(asUser(db, owner, (tx) => tx.query("select public.save_ad_account('company', $1, '1234567', '222222', 's', 't')", [gardens])))
      .rejects.toThrow(/ad_account_taken/);
  });

  it("paginates and sorts campaigns, with categories", async () => {
    const page = await campaigns(adminHub, account, ", p_limit => 2, p_offset => 0");
    expect(page.total).toBe(3);
    expect(page.items.map((c) => c.name)).toEqual(["SGH leads October", "SPH reel promo"]);
    expect(page.items[1].category?.name).toBe("Star Production House");
    const next = await campaigns(adminHub, account, ", p_limit => 2, p_offset => 2");
    expect(next.items.map((c) => c.name)).toEqual(["Brand awareness"]);
    const byName = await campaigns(adminHub, account, ", p_sort => 'name', p_dir => 'asc'");
    expect(byName.items.map((c) => c.name)).toEqual(["Brand awareness", "SGH leads October", "SPH reel promo"]);
    await expect(campaigns(adminHub, account, ", p_sort => 'name; drop table x'")).rejects.toThrow(/invalid_sort/);
  });

  it("shows a campaign's ads newest first with their upload dates", async () => {
    const c1 = (await one<{ id: string }>(db, "select id from public.ad_campaigns where meta_id = 'c1'")).id;
    const d = await asUser(db, adsMgr, async (tx) => (await one<{ r: { ads: { name: string; spend: number }[] } }>(tx,
      "select public.ad_campaign_detail($1, '2026-09-01', '2026-09-30') as r", [c1])).r);
    expect(d.ads.map((a) => a.name)).toEqual(["Video B", "Carousel A"]);
    expect(Number(d.ads[1].spend)).toBe(600);
  });
});

describe("who sees which ads", () => {
  it("gives the owner company's admin and ads managers every campaign", async () => {
    const mine = await asUser(db, adsMgr, async (tx) => (await one<{ r: { id: string; scope: string }[] }>(tx, "select public.ads_accounts_for_me() as r")).r);
    expect(mine).toEqual([expect.objectContaining({ id: account, scope: "all" })]);
    expect((await campaigns(adsMgr)).total).toBe(3);
    expect((await overview(adsMgr)).categories?.map((c) => c.name)).toContain("Star Production House");
  });

  it("limits a merged company to its own category", async () => {
    expect((await campaigns(adminSph)).items.map((c) => c.name)).toEqual(["SPH reel promo"]);
    expect(Number((await overview(adminSph)).totals.spend)).toBe(300);
    expect((await overview(adminSph)).categories).toBeNull();
    await expect(asUser(db, adminSph, (tx) => tx.query("select public.save_ad_category($1, null, 'Mine')", [account]))).rejects.toThrow(/forbidden/);

    // An ads manager assigned only to the member company: same limit, and no switching to the owner.
    expect((await campaigns(adsMgrSph)).items.map((c) => c.name)).toEqual(["SPH reel promo"]);
    await expect(switchTo(adsMgrSph, hub)).rejects.toThrow(/forbidden/);

    // An ads manager assigned to both sees everything only while working in the owner company.
    await switchTo(adsMgr, sph);
    expect((await campaigns(adsMgr)).total).toBe(1);
    await switchTo(adsMgr, hub);
    expect((await campaigns(adsMgr)).total).toBe(3);
  });

  it("cuts access as soon as the super admin unassigns a company", async () => {
    await asUser(db, owner, (tx) => tx.query("select public.set_ads_manager_companies($1, $2::uuid[])", [adsMgr, [sph]]));
    expect((await campaigns(adsMgr)).total).toBe(1);
    await asUser(db, owner, (tx) => tx.query("select public.set_ads_manager_companies($1, $2::uuid[])", [adsMgr, [hub, sph]]));
    await switchTo(adsMgr, hub);
    expect((await campaigns(adsMgr)).total).toBe(3);
  });

  it("gives other roles and unassigned ads managers nothing", async () => {
    for (const user of [salesHub, accountHub, adsMgrNone, adminGardens]) {
      await expect(overview(user)).rejects.toThrow(/forbidden/);
    }
    await expect(asUser(db, adsMgrNone, (tx) => tx.query("select public.ads_accounts_for_me()"))).rejects.toThrow(/forbidden/);
  });

  it("keeps ads managers out of leads, finance and users", async () => {
    await createLead(db, salesHub, { name: "Secret lead" });
    expect(await asUser(db, adsMgr, (tx) => rows(tx, "select id from public.leads"))).toEqual([]);
    expect(await asUser(db, adsMgr, (tx) => rows(tx, "select id from public.expenses"))).toEqual([]);
    await expect(asUser(db, adsMgr, (tx) => tx.query("select public.admin_list_users()"))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, adsMgr, (tx) => tx.query("select public.list_leads()"))).rejects.toThrow();
  });

  it("lets only the super admin manage ads managers and merges", async () => {
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.set_ads_manager_companies($1, $2::uuid[])", [adsMgr, [gardens]]))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.merge_ad_account($1, $2::uuid[])", [account, [gardens]]))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.super_list_ads_managers()"))).rejects.toThrow(/forbidden/);
    const list = await asUser(db, owner, async (tx) => (await one<{ r: { username: string; company_ids: string[] }[] }>(tx, "select public.super_list_ads_managers() as r")).r);
    expect(list.find((m) => m.username === "ads_mgr")?.company_ids).toEqual([hub, sph]);
  });
});

describe("ads clients", () => {
  let lead: string, client: string, clientAccount: string, clientUser: string;

  beforeAll(async () => {
    await db.query("insert into public.telegram_connections (user_id, chat_id) values ($1, 9001)", [adsMgr]);
    lead = await createLead(db, salesHub, { name: "Rao Builders", niche: "Real estate", phone: "+919845000001" });
  });

  it("turns a won lead into one ads client, notifying the ads team", async () => {
    await moveTo(salesHub, lead, await stageId(db, "Won"));
    const c = await one<{ id: string; name: string; business: string; status: string }>(db, "select * from public.ads_clients where lead_id = $1", [lead]);
    expect(c).toMatchObject({ name: "Rao Builders", business: "Real estate", status: "onboarding" });
    client = c.id;
    expect(await rows(db, "select id from public.telegram_notifications where recipient_id = $1 and kind = 'ads_client_new'", [adsMgr])).toHaveLength(1);
    const note = await one<{ body: string }>(db, "select body from public.lead_activities where lead_id = $1 and type = 'note' order by created_at desc limit 1", [lead]);
    expect(note.body).toContain("ads team");

    // Re-winning never duplicates.
    await moveTo(salesHub, lead, await stageId(db, "Lost"));
    await moveTo(salesHub, lead, await stageId(db, "Won"));
    expect(await rows(db, "select id from public.ads_clients where lead_id = $1", [lead])).toHaveLength(1);
  });

  it("does nothing for companies with the switch off", async () => {
    const salesG = await createUser(db, "sales_gardens", "sales", "Sales G", gardens);
    const g = await createLead(db, salesG, { phone: "+919845000002" });
    await moveTo(salesG, g, await stageId(db, "Won", gardens));
    expect(await rows(db, "select id from public.ads_clients where lead_id = $1", [g])).toEqual([]);
    await expect(asUser(db, salesHub, (tx) => tx.query("select public.set_won_to_ads_client($1, true)", [hub]))).rejects.toThrow(/forbidden/);
  });

  it("connects the client's own Meta app and gives the client a read-only login", async () => {
    const list = await asUser(db, adsMgr, async (tx) => (await one<{ r: { items: { id: string }[]; total: number } }>(tx, "select public.list_ads_clients() as r")).r);
    expect(list.items.map((i) => i.id)).toContain(client);
    clientAccount = await asUser(db, adsMgr, async (tx) =>
      (await one<{ id: string }>(tx, "select public.save_ad_account('client', $1, '7654321', '333333', 'client-secret', 'client-token') as id", [client])).id);
    await seedAccountData(clientAccount, "k");

    await asUser(db, adsMgr, (tx) => tx.query("select public.ads_client_login_check($1)", [client]));
    clientUser = await createUser(db, "rao_client", "client", "Rao Builders", hub, client);

    const portal = await asUser(db, clientUser, async (tx) => (await one<{ r: { client: { name: string }; accounts: { id: string; app_id: unknown; scope: string }[] } }>(tx, "select public.my_portal() as r")).r);
    expect(portal.client.name).toBe("Rao Builders");
    expect(portal.accounts).toEqual([expect.objectContaining({ id: clientAccount, scope: "client", app_id: null })]);
    expect(Number((await overview(clientUser, clientAccount)).totals.spend)).toBe(2500);
  });

  it("keeps the client login inside its own portal", async () => {
    await expect(overview(clientUser, account)).rejects.toThrow(/forbidden/);
    expect(await asUser(db, clientUser, (tx) => rows(tx, "select id from public.profiles"))).toEqual([{ id: clientUser }]);
    expect(await asUser(db, clientUser, (tx) => rows(tx, "select id from public.leads"))).toEqual([]);
    expect(await asUser(db, clientUser, (tx) => rows(tx, "select id from public.expenses"))).toEqual([]);
    await expect(asUser(db, clientUser, (tx) => tx.query("select public.list_ads_clients()"))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, clientUser, (tx) => tx.query("select public.save_ad_category($1, null, 'X')", [clientAccount]))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, clientUser, (tx) => tx.query("select public.ads_client_detail($1)", [client]))).rejects.toThrow(/forbidden/);

    // Company admins never see or edit client logins on the Users page.
    const users = await asUser(db, adminHub, async (tx) => (await one<{ r: { items: { id: string }[] } }>(tx, "select public.admin_list_users(p_limit => 100) as r")).r);
    expect(users.items.map((u) => u.id)).not.toContain(clientUser);
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.admin_update_user($1, p_role => 'admin')", [clientUser]))).rejects.toThrow(/not_found/);
  });

  it("closing stops syncing and disables the login but keeps the history", async () => {
    await asUser(db, adsMgr, (tx) => tx.query("select public.set_ads_client_status($1, 'closed')", [client]));
    expect(await one(db, "select is_active from public.profiles where id = $1", [clientUser])).toEqual({ is_active: false });
    expect(await one(db, "select sync_paused from public.ad_accounts where id = $1", [clientAccount])).toEqual({ sync_paused: true });
    const targets = await asService(db, (tx) => rows<{ ad_sync_targets: string }>(tx, "select public.ad_sync_targets(50)"));
    expect(targets.map((t) => t.ad_sync_targets)).not.toContain(clientAccount);
    expect(Number((await overview(adsMgr, clientAccount)).totals.spend)).toBe(2500);
    await expect(overview(clientUser, clientAccount)).rejects.toThrow(/forbidden/);

    await asUser(db, adsMgr, (tx) => tx.query("select public.set_ads_client_status($1, 'active')", [client]));
    expect(await one(db, "select sync_paused from public.ad_accounts where id = $1", [clientAccount])).toEqual({ sync_paused: false });
  });

  it("ads managers can't reach clients of companies they don't handle", async () => {
    await switchTo(adsMgr, sph);
    await expect(asUser(db, adsMgr, (tx) => tx.query("select public.ads_client_detail($1)", [client]))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, adsMgrSph, (tx) => tx.query("select public.ads_client_login_check($1)", [client]))).rejects.toThrow(/forbidden/);
    await switchTo(adsMgr, hub);
  });
});

describe("ads client company names", () => {
  it("carries a won lead's company over, and the ads team can set, edit and search it", async () => {
    const phone = "+919845000077";
    const lead = await asUser(db, salesHub, async (tx) => (await one<{ id: string }>(tx,
      `select public.create_lead(p_name => 'Anil Kumar', p_phone => $1, p_phone_normalized => $1, p_new_niche => 'Real estate',
         p_company_name => 'Kumar Estates') as id`, [phone])).id);
    await moveTo(salesHub, lead, await stageId(db, "Won"));
    const won = await one<{ id: string; name: string; company_name: string; business: string }>(db,
      "select id, name, company_name, business from public.ads_clients where lead_id = $1", [lead]);
    expect(won).toMatchObject({ name: "Anil Kumar", company_name: "Kumar Estates", business: "Real estate" });
    const note = await one<{ payload: Record<string, unknown> }>(db,
      "select payload from public.telegram_notifications where kind = 'ads_client_new' and payload ->> 'ads_client_id' = $1 limit 1", [won.id]);
    expect(note.payload).toMatchObject({ client: "Anil Kumar", client_company: "Kumar Estates" });

    await switchTo(adsMgr, hub);
    const id = await asUser(db, adsMgr, async (tx) => (await one<{ id: string }>(tx,
      "select public.create_ads_client('Priya', p_company_name => 'Priya Salons') as id")).id);
    await asUser(db, adsMgr, (tx) => tx.query("select public.update_ads_client($1, p_company_name => 'Priya Beauty Studio')", [id]));
    // Other fields left out (null) are kept.
    expect(await one(db, "select name, company_name from public.ads_clients where id = $1", [id])).toEqual({ name: "Priya", company_name: "Priya Beauty Studio" });
    const list = await asUser(db, adsMgr, async (tx) => (await one<{ r: { items: { id: string; company_name: string }[] } }>(tx,
      "select public.list_ads_clients(p_search => 'beauty') as r")).r);
    expect(list.items).toEqual([expect.objectContaining({ id, company_name: "Priya Beauty Studio" })]);
  });
});

describe("ads clients on the agency's own ad account", () => {
  type Summary = { sources: { source: string; currency: string; spend: number }[]; totals: { currency: string; spend: number; leads: number }[] };
  let mehta: string, other: string, mehtaUser: string, otherUser: string, category: string;
  const link = (user: string, client: string, args = "p_create => true") =>
    asUser(db, user, async (tx) => (await one<{ id: string | null }>(tx, `select public.set_ads_client_category($1, ${args}) as id`, [client])).id);
  const summary = (user: string, client: string) =>
    asUser(db, user, async (tx) => (await one<{ r: Summary }>(tx, "select public.ads_client_summary($1, '2026-09-01', '2026-09-30') as r", [client])).r);
  const newClient = (name: string) =>
    asUser(db, adsMgr, async (tx) => (await one<{ id: string }>(tx, "select public.create_ads_client($1, p_business => $1) as id", [name])).id);

  beforeAll(async () => {
    await switchTo(adsMgr, hub);
    mehta = await newClient("Mehta Homes");
    other = await newClient("Other Realty");
    mehtaUser = await createUser(db, "mehta_client", "client", "Mehta", hub, mehta);
    otherUser = await createUser(db, "other_client", "client", "Other", hub, other);
  });

  it("needs an ad source before a client goes Active", async () => {
    await expect(asUser(db, adsMgr, (tx) => tx.query("select public.set_ads_client_status($1, 'active')", [mehta]))).rejects.toThrow(/ads_source_required/);
    await asUser(db, adsMgr, (tx) => tx.query("select public.set_ads_client_status($1, 'paused')", [mehta]));
  });

  it("links a category named after the client and files campaigns into it", async () => {
    category = (await link(adsMgr, mehta))!;
    expect(await one(db, "select name, ads_client_id from public.ad_categories where id = $1", [category])).toEqual({ name: "Mehta Homes", ads_client_id: mehta });
    const c3 = (await one<{ id: string }>(db, "select id from public.ad_campaigns where ad_account_id = $1 and meta_id = 'c3'", [account])).id;
    await asUser(db, adsMgr, (tx) => tx.query("select public.set_ad_campaign_category($1::uuid[], $2)", [[c3], category]));
    await asUser(db, adsMgr, (tx) => tx.query("select public.set_ads_client_status($1, 'active')", [mehta]));
    // Linking again reuses the same category.
    expect(await link(adsMgr, mehta)).toBe(category);
  });

  it("shows the client only its own campaigns on the agency account", async () => {
    const o = await overview(mehtaUser);
    expect(o.account.scope).toBe("client_category");
    expect(Number(o.totals.spend)).toBe(200);
    expect(o.categories).toBeNull();
    expect(o.reach_month).toBeNull();
    expect((await campaigns(mehtaUser)).items.map((c) => c.name)).toEqual(["Brand awareness"]);
    const cats = await asUser(db, mehtaUser, async (tx) => (await one<{ r: { id: string }[] }>(tx, "select public.ad_categories_list($1) as r", [account])).r);
    expect(cats.map((k) => k.id)).toEqual([category]);
    const portal = await asUser(db, mehtaUser, async (tx) => (await one<{ r: { agency_sources: { category_id: string; account: { scope: string; app_id: unknown } }[] } }>(tx, "select public.my_portal() as r")).r);
    expect(portal.agency_sources).toEqual([expect.objectContaining({ category_id: category, account: expect.objectContaining({ scope: "client_category", app_id: null }) })]);
    // Another client sees nothing of it.
    await expect(overview(otherUser)).rejects.toThrow(/forbidden/);
    await expect(summary(otherUser, mehta)).rejects.toThrow(/forbidden/);
  });

  it("leaves client categories out of 'our company' and lets the team pick categories", async () => {
    const spend = async (user: string, args: string, params: unknown[] = []) => {
      const o = await asUser(db, user, async (tx) =>
        (await one<{ r: Overview }>(tx, `select public.ads_overview($1, '2026-09-01', '2026-09-30', ${args}) as r`, [account, ...params])).r);
      return { spend: Number(o.totals.spend), reach: o.reach_month };
    };
    const names = async (args: string) => (await asUser(db, adminHub, async (tx) =>
      (await one<{ r: Page }>(tx, `select public.list_ad_campaigns($1, '2026-09-01', '2026-09-30', ${args}) as r`, [account])).r)).items.map((c) => c.name).sort();
    const sphCategory = (await one<{ id: string }>(db, "select id from public.ad_categories where ad_account_id = $1 and company_id = $2", [account, sph])).id;
    const cats = await asUser(db, adminHub, async (tx) => (await one<{ r: { id: string; in_dashboard: boolean }[] }>(tx, "select public.ad_categories_list($1) as r", [account])).r);
    expect(cats.find((k) => k.id === category)?.in_dashboard).toBe(false);
    expect(cats.find((k) => k.id === sphCategory)?.in_dashboard).toBe(true);

    // Everything: 2000 uncategorised + 300 SPH + 200 Mehta. Our company leaves Mehta's 200 out.
    expect((await spend(adminHub, "p_ours => false")).spend).toBe(2500);
    expect(await spend(adminHub, "p_ours => true")).toEqual({ spend: 2300, reach: null });
    expect(await names("p_ours => true")).toEqual(["SGH leads October", "SPH reel promo"]);
    // Several categories, with or without the uncategorised campaigns.
    expect((await spend(adminHub, "p_categories => $2::uuid[]", [[sphCategory, category]])).spend).toBe(500);
    expect((await spend(adminHub, "p_categories => '{}'::uuid[], p_with_uncategorised => true")).spend).toBe(2000);
    expect(await names(`p_categories => '{${category}}'::uuid[], p_with_uncategorised => true`)).toEqual(["Brand awareness", "SGH leads October"]);
    // The client's own view ignores "our company".
    expect((await spend(mehtaUser, "p_ours => true")).spend).toBe(200);

    // Switching a category back to our company counts it again; only the ads team can switch.
    await asUser(db, adsMgr, (tx) => tx.query("select public.set_ad_category_dashboard($1, true)", [category]));
    expect((await spend(adminHub, "p_ours => true")).spend).toBe(2500);
    await expect(asUser(db, salesHub, (tx) => tx.query("select public.set_ad_category_dashboard($1, false)", [category]))).rejects.toThrow(/forbidden/);
    await asUser(db, adsMgr, (tx) => tx.query("select public.set_ad_category_dashboard($1, false)", [category]));
  });

  it("keeps a linked category fixed and refuses taken ones", async () => {
    await asUser(db, adsMgr, (tx) => tx.query("select public.save_ad_category($1, $2, 'Renamed', 'MH')", [account, category]));
    expect(await one(db, "select name, match_text from public.ad_categories where id = $1", [category])).toEqual({ name: "Mehta Homes", match_text: "MH" });
    await expect(asUser(db, adsMgr, (tx) => tx.query("select public.archive_ad_category($1)", [category]))).rejects.toThrow(/category_client/);
    await expect(link(adsMgr, other, `p_category => '${category}'`)).rejects.toThrow(/category_taken/);
    const sphCategory = (await one<{ id: string }>(db, "select id from public.ad_categories where ad_account_id = $1 and company_id = $2", [account, sph])).id;
    await expect(link(adsMgr, other, `p_category => '${sphCategory}'`)).rejects.toThrow(/category_taken/);
    await expect(link(salesHub, other)).rejects.toThrow(/forbidden/);
  });

  it("totals both sources per currency, never mixing currencies", async () => {
    const own = await asUser(db, adsMgr, async (tx) =>
      (await one<{ id: string }>(tx, "select public.save_ad_account('client', $1, '7654322', '444444', 's', 't') as id", [mehta])).id);
    await seedAccountData(own, "m");
    let s = await summary(mehtaUser, mehta);
    expect(s.sources.map((x) => x.source)).toEqual(["agency", "own"]);
    expect(s.totals).toHaveLength(1);
    expect(Number(s.totals[0].spend)).toBe(2700);

    await db.query("update public.ad_accounts set currency = 'USD' where id = $1", [own]);
    s = await summary(adsMgr, mehta);
    expect(s.totals.map((t) => [t.currency, Number(t.spend)])).toEqual([["USD", 2500], ["INR", 200]]);
  });

  it("unlinking keeps the campaigns in the category but ends the client's access", async () => {
    expect(await link(adsMgr, mehta, "p_category => null")).toBeNull();
    // Unlinked, it counts as our company again.
    expect(await one(db, "select ads_client_id, in_dashboard from public.ad_categories where id = $1", [category])).toEqual({ ads_client_id: null, in_dashboard: true });
    expect(await rows(db, "select id from public.ad_campaigns where category_id = $1", [category])).toHaveLength(1);
    await expect(overview(mehtaUser)).rejects.toThrow(/forbidden/);
  });
});

describe("Facebook Lead Ads insights", () => {
  it("counts leads by form, campaign and owner, with spend per lead", async () => {
    await asService(db, async (tx) => {
      for (const [i, phone] of ["+919855500001", "+919855500002"].entries()) {
        await tx.query(`select public.ingest_meta_lead(p_company_id => $1, p_leadgen_id => $2, p_name => 'FB', p_phone => $3,
          p_phone_normalized => $3, p_form_name => 'Site visit form', p_campaign_name => 'SGH leads October')`, [hub, `lg${i}`, phone]);
        await tx.query("select public.set_meta_lead_ad_ids($1, $2, 'c1', 'as1', 'ca1')", [hub, `lg${i}`]);
      }
    });
    await db.query("update public.meta_lead_events set created_at = '2026-09-02T06:00:00Z' where leadgen_id in ('lg0', 'lg1')");
    const r = await asUser(db, adminHub, async (tx) => (await one<{ r: {
      totals: Record<string, number>; forms: { name: string; leads: number }[];
      campaigns: { campaign_id: string; leads: number; spend: number; cpl: number }[];
    } }>(tx, "select public.meta_lead_insights($1, '2026-09-01', '2026-09-30') as r", [hub])).r);
    expect(r.totals).toMatchObject({ created: 2, failed: 0 });
    expect(r.forms).toEqual([{ name: "Site visit form", leads: 2, won: 0 }]);
    expect(r.campaigns[0]).toMatchObject({ campaign_id: "c1", leads: 2 });
    expect(Number(r.campaigns[0].spend)).toBe(2000);
    expect(Number(r.campaigns[0].cpl)).toBe(1000);
    const lead = await one<{ source_meta: Record<string, string> }>(db, "select source_meta from public.leads where source_meta ->> 'leadgen_id' = 'lg0'");
    expect(lead.source_meta).toMatchObject({ campaign_id: "c1", ad_id: "ca1" });
    await expect(asUser(db, salesHub, (tx) => tx.query("select public.meta_lead_insights($1, '2026-09-01', '2026-09-30')", [hub]))).rejects.toThrow(/forbidden/);
  });
});

describe("campaigns that ran recently", () => {
  it("lists the campaigns with spend in the last 7, 14 or 28 days, paused ones included", async () => {
    const ranCo = await createCompany(db, "Ran Recently Co");
    const ranAdmin = await createUser(db, "admin_ran", "admin", "Admin Ran", ranCo);
    const acc = await asUser(db, ranAdmin, async (tx) =>
      (await one<{ id: string }>(tx, "select public.save_ad_account('company', $1, 'act_7777777', '777777', 's', 't') as id", [ranCo])).id);
    await asService(db, (tx) => tx.query("select public.upsert_ad_entities($1, $2, '[]')", [acc, JSON.stringify([
      { meta_id: "r1", name: "Spent 2 days ago (paused)", effective_status: "PAUSED" },
      { meta_id: "r2", name: "Spent 10 days ago", effective_status: "PAUSED" },
      { meta_id: "r3", name: "Spent 20 days ago", effective_status: "ACTIVE" },
      { meta_id: "r4", name: "Only impressions", effective_status: "PAUSED" },
    ])]));
    await db.query(`insert into public.ad_campaign_daily (ad_account_id, campaign_id, date, spend, impressions)
      select $1, c.id, (now() at time zone 'Asia/Kolkata')::date - v.ago, v.spend, 100
      from (values ('r1', 2, 50), ('r2', 10, 70), ('r3', 20, 90), ('r4', 1, 0)) v(meta, ago, spend)
      join public.ad_campaigns c on c.meta_id = v.meta and c.ad_account_id = $1`, [acc]);
    const names = async (status: string) => (await asUser(db, ranAdmin, async (tx) => (await one<{ r: Page }>(tx,
      "select public.list_ad_campaigns($1, current_date - 60, current_date, p_status => $2) as r", [acc, status])).r)).items.map((c) => c.name).sort();
    expect(await names("ran_7")).toEqual(["Spent 2 days ago (paused)"]);
    expect(await names("ran_14")).toEqual(["Spent 10 days ago", "Spent 2 days ago (paused)"]);
    expect(await names("ran_28")).toEqual(["Spent 10 days ago", "Spent 2 days ago (paused)", "Spent 20 days ago"]);
    expect(await names("active")).toEqual(["Spent 20 days ago"]);
    await expect(names("ran_99")).rejects.toThrow(/invalid_sort/);
  });
});
