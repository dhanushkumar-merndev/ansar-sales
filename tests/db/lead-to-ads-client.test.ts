import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createCompany, createDb, createLead, createUser, defaultCompany, one, rows, type Db } from "./harness";

let db: Db;
let hub: string, admin: string, sales: string, owner: string, lead: string;

const add = (user: string, id = lead) =>
  asUser(db, user, async (tx) => (await one<{ id: string }>(tx, "select public.lead_to_ads_client($1) as id", [id])).id);
const linked = (user: string, id = lead) =>
  asUser(db, user, async (tx) => (await one<{ r: { id: string; deleted: boolean } | null }>(tx, "select public.lead_ads_client($1) as r", [id])).r);

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  owner = await createUser(db, "lac_owner", "super_admin");
  admin = await createUser(db, "lac_admin", "admin", "Lac Admin");
  sales = await createUser(db, "lac_sales", "sales", "Lac Sales");
  lead = await createLead(db, sales, { name: "Ravi", niche: "Villas" });
  await db.query("update public.leads set company_name = 'Ravi Builders', email = 'ravi@example.com' where id = $1", [lead]);
});

describe("adding a lead as an ads client", () => {
  it("is for admins and ads managers, not sales", async () => {
    await expect(add(sales)).rejects.toThrow(/forbidden/);
    expect(await linked(sales)).toBeNull();
    expect(await linked(admin)).toBeNull();
  });

  it("creates one client with the lead's details, without marking it won", async () => {
    const id = await add(admin);
    const c = await one<{ name: string; company_name: string; email: string; business: string; lead_id: string; company_id: string }>(db,
      "select name, company_name, email, business, lead_id, company_id from public.ads_clients where id = $1", [id]);
    expect(c).toEqual({ name: "Ravi", company_name: "Ravi Builders", email: "ravi@example.com", business: "Villas", lead_id: lead, company_id: hub });
    expect(await linked(admin)).toEqual({ id, deleted: false });
    expect((await one<{ status: string }>(db, "select status from public.leads where id = $1", [lead])).status).not.toBe("won");
    const notes = await rows(db, "select 1 from public.lead_activities where lead_id = $1 and type = 'note' and body = 'Added as an ads client.'", [lead]);
    expect(notes).toHaveLength(1);

    // Again, or marking it won later: still the same one client.
    expect(await add(owner)).toBe(id);
    await db.query("update public.companies set won_to_ads_client = true where id = $1", [hub]);
    await db.query("update public.leads set status = 'won' where id = $1", [lead]);
    expect(await rows(db, "select 1 from public.ads_clients where lead_id = $1", [lead])).toHaveLength(1);
  });

  it("says when the client was deleted", async () => {
    const id = (await linked(admin))!.id;
    await asUser(db, owner, (tx) => tx.query("select public.delete_ads_client($1)", [id]));
    expect(await linked(admin)).toEqual({ id, deleted: true });
    await expect(add(admin)).rejects.toThrow(/ads_client_deleted/);
  });

  it("refuses our own companies and companies without ads", async () => {
    await createCompany(db, "Star Gardens");
    const ours = await createLead(db, admin, { name: "Star Gardens" });
    await expect(add(admin, ours)).rejects.toThrow(/client_is_our_company/);

    const noAds = await createCompany(db, "Quiet Co");
    await db.query("update public.companies set features = array_append(features, 'no_ads') where id = $1", [noAds]);
    const quietAdmin = await createUser(db, "lac_quiet", "admin", "Quiet Admin", noAds);
    const quietLead = await createLead(db, quietAdmin, { name: "Someone" });
    await expect(add(quietAdmin, quietLead)).rejects.toThrow(/forbidden/);
  });
});
