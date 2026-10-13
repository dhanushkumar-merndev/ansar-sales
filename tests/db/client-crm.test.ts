import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createLead, createUser, defaultCompany, nextPhone, one, rows, type Db } from "./harness";

let db: Db;
let hub: string, other: string, ws: string, client: string;
let owner: string, adminHub: string, salesHub: string, adsMgr: string, adsMgrOther: string, adminOther: string, portalUser: string;
let wsSales: string;

type LeadPage = { items: { id: string; name: string }[]; total: number };
const listLeads = (user: string) =>
  asUser(db, user, async (tx) => (await one<{ r: LeadPage }>(tx, "select public.list_leads(p_limit => 100) as r")).r);
const switchTo = (user: string, company: string) => asUser(db, user, (tx) => tx.query("select public.set_active_company($1)", [company]));
const addLead = (user: string, name: string, ownerId?: string) =>
  asUser(db, user, async (tx) => (await one<{ id: string }>(tx,
    "select public.create_lead(p_name => $1, p_phone => $2, p_phone_normalized => $2, p_new_niche => 'Real estate', p_owner_id => $3) as id",
    [name, nextPhone(), ownerId ?? null])).id);

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  other = await createCompany(db, "Other Co");
  owner = await createUser(db, "owner", "super_admin");
  adminHub = await createUser(db, "admin_hub", "admin", "Admin Hub");
  salesHub = await createUser(db, "sales_hub", "sales", "Sales Hub");
  adsMgr = await createUser(db, "ads_mgr", "ads_manager", "Ads Manager");
  adsMgrOther = await createUser(db, "ads_mgr_other", "ads_manager", "Ads Other");
  adminOther = await createUser(db, "admin_other", "admin", "Admin Other", other);
  await asUser(db, owner, async (tx) => {
    await tx.query("select public.set_ads_manager_companies($1, $2::uuid[])", [adsMgr, [hub]]);
    await tx.query("select public.set_ads_manager_companies($1, $2::uuid[])", [adsMgrOther, [other]]);
  });
  const hubName = (await one<{ name: string }>(db, "select name from public.companies where id = $1", [hub])).name;
  // A client whose company has the agency's own name: the CRM gets a unique one.
  client = await asUser(db, adminHub, async (tx) => (await one<{ id: string }>(tx,
    "select public.create_ads_client('Ashok', p_company_name => $1) as id", [hubName])).id);
  portalUser = await createUser(db, "ashok_portal", "client", "Ashok", hub, client);
  await createLead(db, salesHub, { name: "Agency lead" });
});

describe("opening a client's CRM", () => {
  it("only the ads team can create it; it is idempotent, uniquely named and has a pipeline", async () => {
    await expect(asUser(db, salesHub, (tx) => tx.query("select public.open_ads_client_crm($1)", [client]))).rejects.toThrow(/forbidden/);
    await expect(asUser(db, adminOther, (tx) => tx.query("select public.open_ads_client_crm($1)", [client]))).rejects.toThrow(/forbidden/);
    ws = await asUser(db, adminHub, async (tx) => (await one<{ id: string }>(tx, "select public.open_ads_client_crm($1) as id", [client])).id);
    expect(await asUser(db, adsMgr, async (tx) => (await one<{ id: string }>(tx, "select public.open_ads_client_crm($1) as id", [client])).id)).toBe(ws);
    const c = await one<{ name: string; parent_company_id: string; features: string[] }>(db, "select name, parent_company_id, features from public.companies where id = $1", [ws]);
    expect(c).toMatchObject({ parent_company_id: hub, features: ["client_workspace", "no_ads"] });
    expect(c.name).toMatch(/\(client\)$/);
    expect((await rows(db, "select id from public.pipeline_stages where company_id = $1", [ws])).length).toBeGreaterThan(0);
  });

  it("lets agency admins, assigned ads managers and the super admin in, and nobody else", async () => {
    for (const u of [adminHub, adsMgr, owner]) await switchTo(u, ws);
    for (const u of [salesHub, adsMgrOther, adminOther, portalUser]) {
      await expect(switchTo(u, ws)).rejects.toThrow(/forbidden/);
    }
    const ctx = await asUser(db, adsMgr, async (tx) => (await one<{ r: { company_id: string; roles: string[]; workspace: Record<string, unknown> } }>(tx, "select public.my_context() as r")).r);
    expect(ctx).toMatchObject({ company_id: ws, roles: ["admin"], workspace: { parent_id: hub, member: false, ads_client_id: client } });
  });
});

describe("working inside a client's CRM", () => {
  it("our staff act as admin there, and the two CRMs never mix", async () => {
    const lead = await addLead(adsMgr, "Client lead");
    expect((await listLeads(adminHub)).items.map((l) => l.name)).toEqual(["Client lead"]);
    expect((await listLeads(adsMgr)).items.map((l) => l.id)).toEqual([lead]);

    await switchTo(adminHub, hub);
    expect((await listLeads(adminHub)).items.map((l) => l.name)).toEqual(["Agency lead"]);
    expect((await listLeads(salesHub)).items.map((l) => l.name)).toEqual(["Agency lead"]);
    await switchTo(adminHub, ws);
  });

  it("our staff can own leads there and get the reminders; outsiders can't", async () => {
    const lead = await addLead(adminHub, "Owned by ads manager", adsMgr);
    await asUser(db, adminHub, (tx) => tx.query("insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, 'Call', now() + interval '1 day', $2)", [lead, adminHub]));
    const d = await one<{ recipient_id: string }>(db,
      "select d.recipient_id from public.reminder_deliveries d join public.follow_ups f on f.id = d.follow_up_id where f.lead_id = $1", [lead]);
    expect(d.recipient_id).toBe(adsMgr);
    await expect(addLead(adminHub, "Bad owner", salesHub)).rejects.toThrow(/invalid_owner/);
    await expect(addLead(adminHub, "Bad owner", adminOther)).rejects.toThrow(/invalid_owner/);
  });

  it("the client's own staff see only their leads and can't leave", async () => {
    wsSales = await createUser(db, "ashok_sales", "sales", "Ashok Sales", ws);
    const mine = await addLead(wsSales, "Walk-in");
    expect((await listLeads(wsSales)).items.map((l) => l.id)).toEqual([mine]);
    await expect(switchTo(wsSales, hub)).rejects.toThrow(/forbidden/);
    const ctx = await asUser(db, wsSales, async (tx) => (await one<{ r: { roles: string[]; workspace: { member: boolean } } }>(tx, "select public.my_context() as r")).r);
    expect(ctx.roles).toEqual(["sales"]);
    expect(ctx.workspace.member).toBe(true);
  });

  it("summarises the CRM for the client page", async () => {
    await db.query("update public.follow_ups set due_at = now() - interval '1 hour' where task = 'Call'");
    await switchTo(adminHub, hub);
    const s = await asUser(db, adminHub, async (tx) => (await one<{ r: Record<string, unknown> }>(tx, "select public.ads_client_crm_summary($1) as r", [client])).r);
    expect(s).toMatchObject({ company_id: ws, active_leads: 3, overdue: 1, users: 1 });
    await expect(asUser(db, salesHub, (tx) => tx.query("select public.ads_client_crm_summary($1)", [client]))).rejects.toThrow(/forbidden/);
  });

  it("keeps client CRMs out of the agency's own company list for its admins", async () => {
    // An agency admin can read the workspace row (to switch in), but it is marked as a client CRM.
    const seen = await asUser(db, adminHub, (tx) => rows<{ id: string; parent_company_id: string | null }>(tx, "select id, parent_company_id from public.companies order by created_at"));
    expect(seen).toEqual([{ id: hub, parent_company_id: null }, { id: ws, parent_company_id: hub }]);
    expect(await asUser(db, adminOther, (tx) => rows(tx, "select id from public.companies where id = $1", [ws]))).toEqual([]);
  });

  it("keeps client CRMs out of the super admin's company lists", async () => {
    for (const fn of ["super_list_companies", "super_ads_overview", "super_meta_overview", "super_finance_groups"]) {
      const r = await asUser(db, owner, async (tx) => (await one<{ r: unknown }>(tx, `select public.${fn}() as r`)).r);
      expect(JSON.stringify(r), fn).toContain(hub);
      expect(JSON.stringify(r), fn).not.toContain(ws);
    }
  });

  it("tells our staff which CRM a lead is in, so a link can switch to it", async () => {
    const lead = (await one<{ id: string }>(db, "select id from public.leads where company_id = $1 limit 1", [ws])).id;
    const where = (user: string) => asUser(db, user, async (tx) => (await one<{ r: { id: string } | null }>(tx, "select public.lead_company($1) as r", [lead])).r);
    // The agency admin is back in the agency here; the lead is still found in the client's CRM.
    for (const u of [adminHub, adsMgr, owner, wsSales]) expect((await where(u))?.id).toBe(ws);
    for (const u of [salesHub, adsMgrOther, adminOther, portalUser]) expect(await where(u)).toBeNull();
  });
});

describe("the client's Facebook leads and ad results", () => {
  type Ingest = { state: string; lead_id?: string; owner_id?: string };
  let n = 0;
  const ingest = () => asService(db, async (tx) => (await one<{ r: Ingest }>(tx,
    "select public.ingest_meta_lead(p_company_id => $1, p_leadgen_id => $2, p_name => 'FB lead', p_phone => $3, p_phone_normalized => $3, p_form_name => 'Site visit') as r",
    [ws, `lg-${++n}`, nextPhone()])).r);
  const save = (user: string) => asUser(db, user, (tx) => tx.query("select public.save_meta_integration($1, '555000111', '555000222', 's3cret', 'EAAG-token')", [ws]));

  it("lets our team connect the client's Page, from the agency or from inside the CRM", async () => {
    // adminHub is working in the agency, adsMgr inside the CRM.
    await save(adminHub);
    await save(adsMgr);
    for (const u of [salesHub, adminOther, adsMgrOther, wsSales, portalUser]) await expect(save(u)).rejects.toThrow(/forbidden/);
    const meta = await asUser(db, adminHub, async (tx) => (await one<{ r: { company_id: string; integration: { page_id: string }; candidates: { id: string; ours: boolean }[] } }>(tx,
      "select public.ads_client_crm_meta($1) as r", [client])).r);
    expect(meta).toMatchObject({ company_id: ws, integration: { page_id: "555000222" } });
    // The client's staff first, then ours; never the agency's sales users or the super admin.
    expect(meta.candidates[0]).toEqual(expect.objectContaining({ id: wsSales, ours: false }));
    expect(meta.candidates.filter((c) => c.ours).map((c) => c.id).sort()).toEqual([adminHub, adsMgr].sort());
    await expect(asUser(db, salesHub, (tx) => tx.query("select public.ads_client_crm_meta($1)", [client]))).rejects.toThrow(/forbidden/);
  });

  it("routes the leads to the client's staff or ours, into the client's CRM", async () => {
    const route = (ids: string[]) => asUser(db, adminHub, (tx) => tx.query("select public.set_meta_routing($1, $2::uuid[])", [ws, ids]));
    await expect(route([salesHub])).rejects.toThrow(/invalid_owner/);
    await route([wsSales, adsMgr]);
    const got = [await ingest(), await ingest()];
    expect(got.map((g) => g.state)).toEqual(["created", "created"]);
    expect(got.map((g) => g.owner_id).sort()).toEqual([wsSales, adsMgr].sort());
    expect((await one<{ company_id: string }>(db, "select company_id from public.leads where id = $1", [got[0].lead_id])).company_id).toBe(ws);

    // Nobody chosen and no admin among the client's staff: whoever on our team created the CRM.
    await route([]);
    expect((await ingest()).owner_id).toBe(adminHub);
    const wsAdmin = await createUser(db, "ashok_admin", "admin", "Ashok Admin", ws);
    expect((await ingest()).owner_id).toBe(wsAdmin);
    // The client's own admin can't touch the connection: our team runs it.
    await expect(save(wsAdmin)).rejects.toThrow(/forbidden/);
  });

  it("shows people in the CRM that client's ad results, and no other client's", async () => {
    const other = await asUser(db, adminHub, async (tx) => (await one<{ id: string }>(tx, "select public.create_ads_client('Someone else') as id")).id);
    const portal = (user: string) => asUser(db, user, async (tx) => (await one<{ r: { client: { id: string } } }>(tx, "select public.my_portal() as r")).r);
    const summary = (user: string, c: string) => asUser(db, user, (tx) => tx.query("select public.ads_client_summary($1, current_date - 7, current_date)", [c]));
    for (const u of [wsSales, adsMgr]) {
      expect((await portal(u)).client.id).toBe(client);
      await summary(u, client);
    }
    await expect(summary(wsSales, other)).rejects.toThrow(/forbidden/);
    // In the agency nothing changes: its sales users see no ad results.
    await expect(portal(salesHub)).rejects.toThrow(/forbidden/);
    await expect(summary(salesHub, client)).rejects.toThrow(/forbidden/);
  });
});

describe("leads from campaigns we run for the client on our own ad account", () => {
  type Ingest = { state: string; lead_id?: string; owner_id?: string; company_id?: string };
  let n = 0;
  // Our own connection (the agency's) receives the lead; the campaign decides whose CRM it is.
  const ingest = (campaign: string | null) => asService(db, async (tx) => (await one<{ r: Ingest }>(tx,
    "select public.ingest_meta_lead(p_company_id => $1, p_leadgen_id => $2, p_name => 'Ad lead', p_phone => $3, p_phone_normalized => $3, p_form_name => 'Enquiry', p_campaign_id => $4) as r",
    [hub, `auto-${++n}`, nextPhone(), campaign])).r);

  beforeAll(async () => {
    await switchTo(adminHub, hub);
    const account = await asUser(db, adminHub, async (tx) =>
      (await one<{ id: string }>(tx, "select public.save_ad_account('company', $1, 'act_9988776', '555000111', 'app-secret', 'token') as id", [hub])).id);
    await asService(db, (tx) => tx.query("select public.upsert_ad_entities($1, $2, '[]')", [account, JSON.stringify([
      { meta_id: "cmp-ashok", name: "Ashok site visits", effective_status: "ACTIVE", created_time: "2026-09-01T10:00:00Z" },
      { meta_id: "cmp-ours", name: "Our own leads", effective_status: "ACTIVE", created_time: "2026-09-01T10:00:00Z" },
    ])]));
    const category = await asUser(db, adminHub, async (tx) =>
      (await one<{ id: string }>(tx, "select public.set_ads_client_category($1, p_create => true) as id", [client])).id);
    await db.query("update public.ad_campaigns set category_id = $1 where meta_id = 'cmp-ashok'", [category]);
  });

  it("go to the client's CRM; our own campaigns and unknown ones stay with us", async () => {
    const theirs = await ingest("cmp-ashok");
    expect(theirs).toMatchObject({ state: "created", company_id: ws });
    expect((await one<{ company_id: string }>(db, "select company_id from public.leads where id = $1", [theirs.lead_id])).company_id).toBe(ws);
    for (const c of ["cmp-ours", "cmp-not-synced-yet", null]) expect((await ingest(c)).company_id).toBe(hub);

    // The client's page counts it and lists it; our own inbox says which CRM it went to.
    const meta = await asUser(db, adminHub, async (tx) => (await one<{ r: { leads_7d: number; agency: unknown } }>(tx, "select public.ads_client_crm_meta($1) as r", [client])).r);
    expect(meta.leads_7d).toBeGreaterThanOrEqual(3);
    const inbox = (company: string) => asUser(db, adminHub, async (tx) =>
      (await one<{ r: { lead_id: string; crm: string | null }[] }>(tx, "select public.super_meta_events($1) as r", [company])).r);
    expect((await inbox(ws)).find((e) => e.lead_id === theirs.lead_id)).toMatchObject({ crm: null });
    expect((await inbox(hub)).find((e) => e.lead_id === theirs.lead_id)?.crm).toMatch(/\(client\)$/);
  });

  it("connects the client's own Page with our Meta app: only the Page ID is typed", async () => {
    const connect = (user: string, page: string) => asUser(db, user, (tx) => tx.query("select public.connect_client_page($1, $2)", [client, page]));
    // We have no Facebook connection of our own yet.
    await expect(connect(adminHub, "777000111")).rejects.toThrow(/meta_secrets_required/);
    await asUser(db, adminHub, (tx) => tx.query("select public.save_meta_integration($1, '424242424', '900900900', 'our-secret', 'our-token')", [hub]));
    await expect(connect(adminHub, "900900900")).rejects.toThrow(/page_already_connected/);
    await expect(connect(salesHub, "777000111")).rejects.toThrow(/forbidden/);
    await connect(adminHub, "777000111");
    const s = await asService(db, (tx) => one<{ app_id: string; page_id: string; app_secret: string; access_token: string }>(tx, "select * from public.meta_integration_secrets($1)", [ws]));
    expect(s).toMatchObject({ app_id: "424242424", page_id: "777000111", app_secret: "our-secret", access_token: "our-token" });
    const meta = await asUser(db, adminHub, async (tx) => (await one<{ r: { agency: { app_id: string; categories: string[] } } }>(tx, "select public.ads_client_crm_meta($1) as r", [client])).r);
    expect(meta.agency).toMatchObject({ app_id: "424242424", page_id: "900900900" });
    expect(meta.agency.categories).toHaveLength(1);
  });

  it("the client's page shows the client's own company name, not ours", async () => {
    const d = await asUser(db, adminHub, async (tx) => (await one<{ r: { company_name: string | null; agency_name: string } }>(tx, "select public.ads_client_detail($1) as r", [client])).r);
    const hubName = (await one<{ name: string }>(db, "select name from public.companies where id = $1", [hub])).name;
    expect(d.agency_name).toBe(hubName);
    // This test client's company happens to share our name (see the top of the file); the key is the client's own field.
    expect(d.company_name).toBe((await one<{ company_name: string }>(db, "select company_name from public.ads_clients where id = $1", [client])).company_name);
  });
});
