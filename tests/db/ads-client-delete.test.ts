import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createUser, defaultCompany, nextPhone, one, rows, type Db } from "./harness";

let db: Db;
let hub: string, owner: string, adminHub: string, client: string, ws: string, portalUser: string, wsSales: string, lead: string, account: string;

type Deleted = { id: string; can_purge: boolean; crm_leads: number; exported_at: string | null };
const deletedList = () => asUser(db, owner, async (tx) => (await one<{ r: Deleted[] }>(tx, "select public.super_deleted_ads_clients() as r")).r);
const call = (user: string, fn: string, id = client) => asUser(db, user, (tx) => tx.query(`select public.${fn}($1)`, [id]));
const exportSection = (section: string) =>
  asUser(db, owner, async (tx) => (await one<{ r: Record<string, unknown>[] }>(tx, "select public.ads_client_export($1, $2) as r", [client, section])).r);

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  owner = await createUser(db, "owner", "super_admin");
  adminHub = await createUser(db, "admin_hub", "admin", "Admin Hub");
  client = await asUser(db, adminHub, async (tx) => (await one<{ id: string }>(tx, "select public.create_ads_client('Ravi', p_company_name => 'Ravi Builders') as id")).id);
  portalUser = await createUser(db, "ravi_portal", "client", "Ravi", hub, client);
  ws = await asUser(db, adminHub, async (tx) => (await one<{ id: string }>(tx, "select public.open_ads_client_crm($1) as id", [client])).id);
  wsSales = await createUser(db, "ravi_sales", "sales", "Ravi Sales", ws);
  lead = await asUser(db, wsSales, async (tx) => (await one<{ id: string }>(tx,
    "select public.create_lead(p_name => 'Walk-in', p_phone => $1, p_phone_normalized => $1, p_new_niche => 'Villas', p_note => 'Wants a 3BHK') as id", [nextPhone()])).id);
  await asUser(db, wsSales, (tx) => tx.query("insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, 'Call back', now() + interval '1 day', $2)", [lead, wsSales]));
  account = await asUser(db, adminHub, async (tx) =>
    (await one<{ id: string }>(tx, "select public.save_ad_account('client', $1, '7654321', '333333', 'client-secret', 'client-token') as id", [client])).id);
  await asService(db, async (tx) => {
    await tx.query("select public.upsert_ad_entities($1, $2, '[]')", [account, JSON.stringify([{ meta_id: "c1", name: "Villa leads", effective_status: "ACTIVE" }])]);
    await tx.query("insert into public.ad_campaign_daily (ad_account_id, campaign_id, date, spend, impressions, clicks, leads) select $1, id, '2026-10-01', 500, 1000, 20, 3 from public.ad_campaigns where meta_id = 'c1'", [account]);
  });
});

describe("deleting an ads client", () => {
  it("only the super admin deletes; the client then disappears and its CRM closes", async () => {
    await expect(call(adminHub, "delete_ads_client")).rejects.toThrow(/forbidden/);
    await call(owner, "delete_ads_client");
    const list = await asUser(db, adminHub, async (tx) => (await one<{ r: { items: { id: string }[] } }>(tx, "select public.list_ads_clients() as r")).r);
    expect(list.items.map((c) => c.id)).not.toContain(client);
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.ads_client_detail($1)", [client]))).rejects.toThrow(/forbidden/);
    const c = await one<{ status: string; archived: boolean; portal_active: boolean; reminder: string }>(db, `select c.status,
        (select k.archived_at is not null from public.companies k where k.id = c.workspace_company_id) as archived,
        (select p.is_active from public.profiles p where p.id = $2) as portal_active,
        (select d.state::text from public.reminder_deliveries d join public.follow_ups f on f.id = d.follow_up_id where f.lead_id = $3) as reminder
      from public.ads_clients c where c.id = $1`, [client, portalUser, lead]);
    expect(c).toEqual({ status: "closed", archived: true, portal_active: false, reminder: "skipped" });
    // Nobody works in the CRM any more.
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.set_active_company($1)", [ws]))).rejects.toThrow();
    expect(await deletedList()).toEqual([expect.objectContaining({ id: client, can_purge: false, crm_leads: 1, exported_at: null })]);
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.super_deleted_ads_clients()"))).rejects.toThrow(/forbidden/);
  });

  it("can be restored, and deleted again", async () => {
    await call(owner, "restore_ads_client");
    expect(await deletedList()).toEqual([]);
    expect((await one<{ archived_at: string | null }>(db, "select archived_at from public.companies where id = $1", [ws])).archived_at).toBeNull();
    await call(owner, "delete_ads_client");
  });

  it("exports every sheet of a deleted client", async () => {
    expect((await exportSection("client"))[0]).toMatchObject({ company_name: "Ravi Builders", contact: "Ravi" });
    expect((await exportSection("logins")).map((l) => [l.username, l.kind])).toEqual([["ravi_portal", "Portal login"], ["ravi_sales", "CRM user"]]);
    expect(await exportSection("leads")).toEqual([expect.objectContaining({ name: "Walk-in", niche: "Villas", owner: "Ravi Sales" })]);
    expect((await exportSection("timeline")).some((a) => a.text === "Wants a 3BHK")).toBe(true);
    expect(await exportSection("follow_ups")).toEqual([expect.objectContaining({ task: "Call back" })]);
    expect(await exportSection("campaigns")).toEqual([expect.objectContaining({ name: "Villa leads", spend: 500, leads: 3 })]);
    expect(await exportSection("daily")).toEqual([expect.objectContaining({ date: "2026-10-01", campaign: "Villa leads" })]);
    await expect(exportSection("nope")).rejects.toThrow(/invalid_section/);
    await expect(asUser(db, adminHub, (tx) => tx.query("select public.ads_client_export($1, 'leads')", [client]))).rejects.toThrow(/forbidden/);
  });

  it("deletes permanently only after an export, and removes everything of the client", async () => {
    await expect(call(owner, "purge_ads_client")).rejects.toThrow(/export_required/);
    await call(owner, "mark_ads_client_exported");
    expect((await deletedList())[0].can_purge).toBe(true);
    await expect(call(adminHub, "purge_ads_client")).rejects.toThrow(/forbidden/);
    const removed = await asUser(db, owner, async (tx) => (await one<{ r: string[] }>(tx, "select public.purge_ads_client($1) as r", [client])).r);
    expect(removed.sort()).toEqual([portalUser, wsSales].sort());
    const left = await one<Record<string, number>>(db, `select
      (select count(*)::int from public.ads_clients where id = $1) as client,
      (select count(*)::int from public.companies where id = $2) as crm,
      (select count(*)::int from public.leads where id = $3) as lead,
      (select count(*)::int from public.follow_ups where lead_id = $3) as follow_ups,
      (select count(*)::int from public.profiles where id = any($4::uuid[])) as logins,
      (select count(*)::int from public.ad_accounts where id = $5) as account,
      (select count(*)::int from public.ad_campaigns where ad_account_id = $5) as campaigns`, [client, ws, lead, removed, account]);
    expect(left).toEqual({ client: 0, crm: 0, lead: 0, follow_ups: 0, logins: 0, account: 0, campaigns: 0 });
    // The audit trail keeps the story.
    const audit = await rows<{ action: string }>(db, "select action from public.admin_audit_log where meta ->> 'ads_client_id' = $1 order by created_at", [client]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["ads_client_deleted", "ads_client_restored", "ads_client_exported", "ads_client_purged"]));
    expect(await deletedList()).toEqual([]);
  });

  it("asks for a new export after a restore and delete", async () => {
    const other = await asUser(db, adminHub, async (tx) => (await one<{ id: string }>(tx, "select public.create_ads_client('Other') as id")).id);
    await call(owner, "delete_ads_client", other);
    await call(owner, "mark_ads_client_exported", other);
    await call(owner, "restore_ads_client", other);
    await call(owner, "delete_ads_client", other);
    await expect(call(owner, "purge_ads_client", other)).rejects.toThrow(/export_required/);
  });
});
