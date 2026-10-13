import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createUser, defaultCompany, nextPhone, one, type Db } from "./harness";

let db: Db;
let hub: string, client: string, otherClient: string, ws: string;
let adminHub: string, salesHub: string, portalUser: string, otherPortal: string, wsSales: string;

type Page = { items: { name: string; stage: string; phone: string }[]; total: number };
const portalLeads = (user: string, search: string | null = null, limit = 20, offset = 0) =>
  asUser(db, user, async (tx) => (await one<{ r: Page }>(tx,
    "select public.portal_leads($1, $2, $3) as r", [search, limit, offset])).r);
const setShow = (user: string, on: boolean, id = client) =>
  asUser(db, user, (tx) => tx.query("select public.set_client_portal_leads($1, $2)", [id, on]));
const portal = (user: string) =>
  asUser(db, user, async (tx) => (await one<{ r: { show_leads: boolean } }>(tx, "select public.my_portal() as r")).r);

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  adminHub = await createUser(db, "pl_admin", "admin", "Admin Hub");
  salesHub = await createUser(db, "pl_sales", "sales", "Sales Hub");
  [client, otherClient] = await asUser(db, adminHub, async (tx) => [
    (await one<{ id: string }>(tx, "select public.create_ads_client('Ashok') as id")).id,
    (await one<{ id: string }>(tx, "select public.create_ads_client('Ravi') as id")).id,
  ]);
  portalUser = await createUser(db, "pl_ashok", "client", "Ashok", hub, client);
  otherPortal = await createUser(db, "pl_ravi", "client", "Ravi", hub, otherClient);
});

describe("client portal leads", () => {
  it("needs the client's CRM before it can be switched on, and only the ads team can switch it", async () => {
    await expect(setShow(adminHub, true)).rejects.toThrow(/no_crm/);
    ws = await asUser(db, adminHub, async (tx) => (await one<{ id: string }>(tx, "select public.open_ads_client_crm($1) as id", [client])).id);
    await expect(setShow(salesHub, true)).rejects.toThrow(/forbidden/);
    await expect(setShow(portalUser, true)).rejects.toThrow(/forbidden/);
  });

  it("is off by default: the portal hides the tab and the leads are refused", async () => {
    expect((await portal(portalUser)).show_leads).toBe(false);
    await expect(portalLeads(portalUser)).rejects.toThrow(/forbidden/);
  });

  it("shows the CRM's active leads, read-only fields only, to that client's login", async () => {
    // Leads inside the client's CRM, added by our admin working there.
    await asUser(db, adminHub, (tx) => tx.query("select public.set_active_company($1)", [ws]));
    for (const name of ["Kiran", "Meena", "Arjun"]) {
      await asUser(db, adminHub, (tx) => tx.query(
        "select public.create_lead(p_name => $1, p_phone => $2, p_phone_normalized => $2, p_new_niche => 'Villa', p_note => 'private note')",
        [name, nextPhone()]));
    }
    await db.query("update public.leads set archived_at = now() where name = 'Arjun'");
    // The switch is on the client's page, in the agency.
    await asUser(db, adminHub, (tx) => tx.query("select public.set_active_company($1)", [hub]));
    await setShow(adminHub, true);

    expect((await portal(portalUser)).show_leads).toBe(true);
    const p = await portalLeads(portalUser);
    expect(p.total).toBe(2);
    expect(p.items.map((l) => l.name)).toEqual(["Meena", "Kiran"]);
    expect(Object.keys(p.items[0]).sort()).toEqual(["company_name", "created_at", "email", "id", "name", "phone", "source", "stage", "status"]);
  });

  it("searches and pages with matching totals", async () => {
    expect((await portalLeads(portalUser, "kir")).items.map((l) => l.name)).toEqual(["Kiran"]);
    const first = await portalLeads(portalUser, null, 1, 0);
    const second = await portalLeads(portalUser, null, 1, 1);
    expect([first.total, second.total]).toEqual([2, 2]);
    expect([...first.items, ...second.items].map((l) => l.name)).toEqual(["Meena", "Kiran"]);
    await expect(portalLeads(portalUser, null, 101)).rejects.toThrow(/invalid_page/);
  });

  it("nobody else reads them through the portal function", async () => {
    await expect(portalLeads(otherPortal)).rejects.toThrow(/forbidden/);
    await expect(portalLeads(adminHub)).rejects.toThrow(/forbidden/);
    await expect(portalLeads(salesHub)).rejects.toThrow(/forbidden/);
    wsSales = await createUser(db, "pl_ws_sales", "sales", "Client Sales", ws);
    await expect(portalLeads(wsSales)).rejects.toThrow(/forbidden/);
    await expect(setShow(wsSales, false)).rejects.toThrow(/forbidden/);
  });

  it("switching it off hides them again", async () => {
    await setShow(adminHub, false);
    expect((await portal(portalUser)).show_leads).toBe(false);
    await expect(portalLeads(portalUser)).rejects.toThrow(/forbidden/);
  });
});
