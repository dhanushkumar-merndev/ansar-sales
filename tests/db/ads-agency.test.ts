import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createLead, createUser, defaultCompany, one, stageId, type Db } from "./harness";

// Only the agency (Star Growth Hub, "ads_agency") turns leads into ads clients; other companies with
// ads connect their own Facebook but have no clients.
let db: Db;
let hub: string, farm: string, hubAdmin: string, farmAdmin: string, superAdmin: string;

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  farm = await createCompany(db, "Star Managed Farmlands 2");
  hubAdmin = await createUser(db, "agency_hub_admin", "admin", "Hub Admin");
  farmAdmin = await createUser(db, "agency_farm_admin", "admin", "Farm Admin", farm);
  superAdmin = await createUser(db, "agency_super", "super_admin" as never, "Super");
  // Won leads would become clients if the company allowed it.
  await db.query("update public.companies set won_to_ads_client = true where id = $1", [farm]);
});

const features = async (company: string) => (await one<{ f: string[] }>(db, "select features as f from public.companies where id = $1", [company])).f;
const leadClient = (uid: string, lead: string) => asUser(db, uid, async (tx) => (await one<{ r: unknown }>(tx, "select public.lead_ads_client($1) as r", [lead])).r);
const addAsClient = (uid: string, lead: string) => asUser(db, uid, (tx) => tx.query("select public.lead_to_ads_client($1)", [lead]));
const clientCount = async (company: string) => Number((await one<{ n: number }>(db, "select count(*)::int as n from public.ads_clients where company_id = $1", [company])).n);

describe("ads agency", () => {
  it("is on for Star Growth Hub only", async () => {
    expect(await features(hub)).toContain("ads_agency");
    expect(await features(farm)).not.toContain("ads_agency");
  });

  it("lets the agency add a lead as a client", async () => {
    const lead = await createLead(db, hubAdmin, { name: "Agency lead" });
    expect(await leadClient(hubAdmin, lead)).toBeNull();
    await addAsClient(hubAdmin, lead);
    expect(await leadClient(hubAdmin, lead)).toMatchObject({ deleted: false });
  });

  it("gives other companies no clients: no button, no Won handoff, no manual client", async () => {
    const lead = await createLead(db, farmAdmin, { name: "Farm lead" });
    expect(await leadClient(farmAdmin, lead)).toBeNull();
    await expect(addAsClient(farmAdmin, lead)).rejects.toThrow(/forbidden/);

    // Marking it Won still works; it just creates no client.
    const won = await stageId(db, "Won", farm);
    await asUser(db, farmAdmin, (tx) => tx.query("update public.leads set stage_id = $2 where id = $1", [lead, won]));
    expect(await clientCount(farm)).toBe(0);

    await expect(asUser(db, farmAdmin, (tx) => tx.query("select public.create_ads_client('Someone')"))).rejects.toThrow(/forbidden/);
    expect(await clientCount(farm)).toBe(0);
  });

  it("is switched by the super admin only", async () => {
    await expect(asUser(db, farmAdmin, (tx) => tx.query("select public.set_company_feature($1, 'ads_agency', true)", [farm]))).rejects.toThrow(/forbidden/);
    await asUser(db, superAdmin, (tx) => tx.query("select public.set_company_feature($1, 'ads_agency', true)", [farm]));
    const lead = await createLead(db, farmAdmin, { name: "Farm lead 2" });
    await addAsClient(farmAdmin, lead);
    expect(await clientCount(farm)).toBe(1);
  });
});
