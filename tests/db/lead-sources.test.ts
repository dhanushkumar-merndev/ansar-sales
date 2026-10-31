import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createLead, createUser, nextPhone, one, rows, type Db } from "./harness";

// 20261008005700_lead_sources: a lead's source as a per-company pick list, like Niche.

let db: Db;
let admin: string, salesA: string, salesB: string, account: string, farmAdmin: string;

type Item = { id: string; source: string; source_name: string | null };
type Page = { items: Item[]; total: number };

const create = (userId: string, opts: { name?: string; sourceId?: string | null; newSource?: string | null } = {}) =>
  asUser(db, userId, async (tx) => (await one<{ id: string }>(tx,
    `select public.create_lead(p_name => $1, p_phone => $2, p_phone_normalized => $2, p_new_niche => 'Retail',
       p_source_id => $3, p_new_source => $4) as id`,
    [opts.name ?? "Lead", nextPhone(), opts.sourceId ?? null, opts.newSource ?? null])).id);
const sourceOf = async (leadId: string) =>
  (await one<{ source_id: string | null; name: string | null }>(db,
    "select l.source_id, s.name from public.leads l left join public.lead_sources s on s.id = l.source_id where l.id = $1", [leadId]));
const update = (userId: string, leadId: string, opts: { set: boolean; sourceId?: string | null; newSource?: string | null }) =>
  asUser(db, userId, async (tx) => {
    const l = await one<{ name: string; phone: string; phone_normalized: string; niche_id: string; version: number }>(tx,
      "select name, phone, phone_normalized, niche_id, version from public.leads where id = $1", [leadId]);
    await tx.query(
      `select public.update_lead(p_id => $1, p_version => $2, p_name => $3, p_phone => $4, p_phone_normalized => $5,
         p_niche_id => $6, p_set_source => $7, p_source_id => $8, p_new_source => $9)`,
      [leadId, l.version, l.name, l.phone, l.phone_normalized, l.niche_id, opts.set, opts.sourceId ?? null, opts.newSource ?? null]);
  });
const list = (userId: string, args: Record<string, unknown>) => {
  const keys = Object.keys(args);
  return asUser(db, userId, async (tx) => (await tx.query<{ r: Page }>(
    `select public.list_leads(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, Object.values(args))).rows[0].r);
};

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
  account = await createUser(db, "account", "account", "Account");
  farmAdmin = await createUser(db, "farm.admin", "admin", "Farm admin", await createCompany(db, "Star Managed Farmlands"));
});

describe("lead sources", () => {
  it("creates a typed source once per company (any case or spacing) and shares it with lead users", async () => {
    const a = await create(salesA, { newSource: "Instagram" });
    const b = await create(salesB, { newSource: "  instagram  " });
    const sa = await sourceOf(a), sb = await sourceOf(b);
    expect(sa.name).toBe("Instagram");
    expect(sb.source_id).toBe(sa.source_id);
    const seen = await asUser(db, salesB, (tx) => rows<{ name: string }>(tx, "select name from public.lead_sources"));
    expect(seen.map((s) => s.name)).toContain("Instagram");
    // Not Account, not another company.
    expect(await asUser(db, account, (tx) => rows(tx, "select 1 from public.lead_sources"))).toEqual([]);
    expect(await asUser(db, farmAdmin, (tx) => rows(tx, "select 1 from public.lead_sources"))).toEqual([]);
  });

  it("is optional, and refuses another company's source and direct writes", async () => {
    const none = await create(salesA);
    expect((await sourceOf(none)).source_id).toBeNull();
    const { source_id } = await sourceOf(await create(salesA, { newSource: "Referral" }));
    await expect(create(farmAdmin, { sourceId: source_id })).rejects.toThrow(/source_not_found/);
    await expect(asUser(db, salesA, (tx) => tx.query("insert into public.lead_sources (company_id, name) select company_id, 'x' from public.leads limit 1"))).rejects.toThrow();
    await expect(create(salesA, { newSource: "x".repeat(41) })).rejects.toThrow(/source_too_long/);
  });

  it("changes on edit only when asked, and logs the change in the history", async () => {
    const lead = await create(salesA, { newSource: "Website" });
    const created = await one<{ meta: { source: string } }>(db, "select meta from public.lead_activities where lead_id = $1 and type = 'lead_created'", [lead]);
    expect(created.meta.source).toBe("Website");

    await update(salesA, lead, { set: false });
    expect((await sourceOf(lead)).name).toBe("Website"); // an older app that doesn't send the source keeps it
    await update(salesA, lead, { set: true, newSource: "Walk-in" });
    expect((await sourceOf(lead)).name).toBe("Walk-in");
    const log = await one<{ meta: { changes: Record<string, { from: string; to: string }> } }>(db,
      "select meta from public.lead_activities where lead_id = $1 and type = 'lead_updated' order by created_at desc limit 1", [lead]);
    expect(log.meta.changes.Source).toEqual({ from: "Website", to: "Walk-in" });
    await update(salesA, lead, { set: true });
    expect((await sourceOf(lead)).source_id).toBeNull();
  });

  it("imports a row's source", async () => {
    const out = await asUser(db, salesA, async (tx) => (await one<{ r: { id?: string; error?: string }[] }>(tx,
      "select public.import_leads($1::jsonb) as r", [JSON.stringify([
        { name: "Imported 1", phone: "+919800000001", phone_normalized: "+919800000001", new_niche: "Retail", new_source: "IndiaMART" },
        { name: "Imported 2", phone: "+919800000002", phone_normalized: "+919800000002", new_niche: "Retail" },
      ])])).r);
    expect(out.every((o) => o.id)).toBe(true);
    expect((await sourceOf(out[0].id!)).name).toBe("IndiaMART");
    expect((await sourceOf(out[1].id!)).source_id).toBeNull();
  });

  it("filters the list by a source or Facebook, returns source_name, and counts ranges by it", async () => {
    const owner = await createUser(db, "sales.filter", "sales", "Filter");
    const web = await create(owner, { newSource: "Web form" });
    await create(owner, { newSource: "Web form" });
    const fb = await createLead(db, owner, { name: "From Facebook" });
    await asService(db, (tx) => tx.query("update public.leads set source = 'facebook' where id = $1", [fb]));
    const sourceId = (await sourceOf(web)).source_id!;

    const bySource = await list(owner, { p_source: sourceId, p_limit: 50 });
    expect(bySource.total).toBe(2);
    expect(bySource.items.every((i) => i.source_name === "Web form")).toBe(true);
    const byFb = await list(owner, { p_source: "facebook", p_limit: 50 });
    expect(byFb.items.map((i) => i.id)).toEqual([fb]);
    expect(byFb.items[0]).toMatchObject({ source: "facebook", source_name: null });
    await expect(list(owner, { p_source: "nonsense" })).rejects.toThrow(/invalid_source/);

    const range = await asUser(db, owner, async (tx) => (await one<{ r: { count: number } }>(tx,
      "select public.lead_range_summary(p_source => $1, p_from => 1, p_to => 100) as r", [sourceId])).r);
    expect(range.count).toBe(2);
  });

  it("exports the source name", async () => {
    const lead = await create(admin, { name: "Exported", newSource: "Hoarding" });
    const out = await asUser(db, admin, async (tx) => (await one<{ r: { id: string; source_name: string | null }[] }>(tx,
      "select public.export_leads(p_limit => 1000) as r")).r);
    expect(out.find((l) => l.id === lead)?.source_name).toBe("Hoarding");
  });
});
