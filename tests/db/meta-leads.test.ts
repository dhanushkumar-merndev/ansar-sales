import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createCompany, createDb, createUser, one, rows, type Db } from "./harness";

let db: Db;
let gardens: string;
let owner: string, adminG: string, adminHub: string, salesG1: string, salesG2: string, salesHub: string;

type Ingest = { state: string; lead_id?: string; owner_id?: string };
let seq = 0;
const ingest = (phone: string, extra: Record<string, unknown> = {}) => {
  seq += 1;
  const id = String(extra.leadgen_id ?? `${900000 + seq}`);
  return asService(db, async (tx) => (await one<{ r: Ingest }>(tx,
    `select public.ingest_meta_lead(p_company_id => $1, p_leadgen_id => $2, p_name => $3, p_phone => $4, p_phone_normalized => $4,
       p_email => $5, p_form_id => '777', p_form_name => 'Garden design enquiry', p_ad_name => 'Diwali offer', p_answers => $6) as r`,
    [gardens, id, extra.name ?? "Priya", phone, extra.email ?? null, extra.answers ?? null])).r);
};

beforeAll(async () => {
  db = await createDb();
  gardens = await createCompany(db, "Star Gardens");
  owner = await createUser(db, "owner", "super_admin");
  adminG = await createUser(db, "admin_g", "admin", "Admin G", gardens);
  salesG1 = await createUser(db, "sales_g1", "sales", "Sales G1", gardens);
  salesG2 = await createUser(db, "sales_g2", "sales", "Sales G2", gardens);
  salesHub = await createUser(db, "sales_hub", "sales", "Sales Hub");
  adminHub = await createUser(db, "admin_hub", "admin", "Admin Hub");
});

describe("configuration", () => {
  it("stores secrets in Vault and never returns them to users", async () => {
    await asUser(db, owner, (tx) => tx.query("select public.save_meta_integration($1, '123456789', '987654321', 's3cret', 'EAAG-token')", [gardens]));
    const overview = await asUser(db, owner, async (tx) => (await one<{ r: { company_id: string; integration: Record<string, unknown> | null }[] }>(tx,
      "select public.super_meta_overview() as r")).r);
    const g = overview.find((c) => c.company_id === gardens)!;
    expect(g.integration).toMatchObject({ app_id: "123456789", page_id: "987654321", status: "unverified" });
    expect(JSON.stringify(overview)).not.toContain("s3cret");
    expect(JSON.stringify(overview)).not.toContain("EAAG-token");
    const secrets = await asService(db, async (tx) => one<{ app_secret: string; access_token: string }>(tx, "select * from public.meta_integration_secrets($1)", [gardens]));
    expect(secrets).toMatchObject({ app_secret: "s3cret", access_token: "EAAG-token" });

    // Updating without secrets keeps them.
    await asUser(db, owner, (tx) => tx.query("select public.save_meta_integration($1, '123456789', '987654321')", [gardens]));
    expect((await asService(db, async (tx) => one<{ app_secret: string }>(tx, "select * from public.meta_integration_secrets($1)", [gardens]))).app_secret).toBe("s3cret");
  });

  it("lets a company admin manage only their own company", async () => {
    await asUser(db, adminG, (tx) => tx.query("select public.save_meta_integration($1, '123456789', '987654321')", [gardens]));
    await asUser(db, adminG, (tx) => tx.query("select public.set_meta_routing($1, $2::uuid[])", [gardens, []]));
    const mine = await asUser(db, adminG, async (tx) => (await one<{ r: { company_id: string }[] }>(tx, "select public.super_meta_overview() as r")).r);
    expect(mine.map((c) => c.company_id)).toEqual([gardens]);
    expect(JSON.stringify(mine)).not.toContain("s3cret");
    await asUser(db, adminG, (tx) => tx.query("select public.super_meta_events($1)", [gardens]));

    for (const sql of [
      "select public.save_meta_integration($1, '1234567', '7654321', 'x', 'y')",
      "select public.set_meta_routing($1, '{}'::uuid[])",
      "select public.delete_meta_integration($1)",
      "select public.super_meta_events($1)",
    ]) {
      await expect(asUser(db, adminHub, (tx) => tx.query(sql, [gardens]))).rejects.toThrow(/forbidden/);
      await expect(asUser(db, salesG1, (tx) => tx.query(sql, [gardens]))).rejects.toThrow(/forbidden/);
    }
    const theirs = await asUser(db, adminHub, async (tx) => (await one<{ r: { company_id: string }[] }>(tx, "select public.super_meta_overview() as r")).r);
    expect(theirs.map((c) => c.company_id)).not.toContain(gardens);
    await expect(asUser(db, salesG1, (tx) => tx.query("select public.super_meta_overview()"))).rejects.toThrow(/forbidden/);
  });

  it("keeps secrets and ingestion server-only", async () => {
    await expect(asUser(db, adminG, (tx) => tx.query("select * from public.meta_integration_secrets($1)", [gardens]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, owner, (tx) => tx.query("select * from public.meta_integration_secrets($1)", [gardens]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, adminG, (tx) => tx.query("select public.ingest_meta_lead($1, '1', 'X', '+919800000000', '+919800000000')", [gardens]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, owner, (tx) => tx.query("select public.set_meta_routing($1, $2::uuid[])", [gardens, [salesHub]]))).rejects.toThrow(/invalid_owner/);
  });
});

describe("ingest", () => {
  it("falls back to the company admin when nobody is routed", async () => {
    const r = await ingest("+919811100001", { email: "PRIYA@Example.com", answers: "Budget: 2 lakh" });
    expect(r).toMatchObject({ state: "created", owner_id: adminG });
    const lead = await one<Record<string, unknown>>(db, "select company_id, email, source, source_meta, status, (select name from public.niches n where n.id = niche_id) as niche from public.leads where id = $1", [r.lead_id]);
    expect(lead).toMatchObject({ company_id: gardens, email: "priya@example.com", source: "facebook", status: "open", niche: "Garden design enquiry" });
    expect(lead.source_meta).toMatchObject({ form_name: "Garden design enquiry", ad_name: "Diwali offer" });
    const acts = await rows<{ type: string; actor_id: string | null; body: string | null }>(db,
      "select type, actor_id, body from public.lead_activities where lead_id = $1 order by created_at, type", [r.lead_id]);
    expect(acts.find((a) => a.type === "lead_created")?.actor_id).toBeNull();
    expect(acts.find((a) => a.type === "note")?.body).toContain("Budget: 2 lakh");
  });

  it("is idempotent per leadgen id", async () => {
    const first = await ingest("+919811100002", { leadgen_id: "555001" });
    const again = await ingest("+919811100002", { leadgen_id: "555001" });
    expect(again).toEqual({ state: "created", lead_id: first.lead_id });
    expect(await rows(db, "select id from public.leads where phone_normalized = '+919811100002'")).toHaveLength(1);
  });

  it("round-robins between routed sales users and skips inactive ones", async () => {
    await asUser(db, owner, (tx) => tx.query("select public.set_meta_routing($1, $2::uuid[])", [gardens, [salesG1, salesG2]]));
    const owners = [];
    for (let i = 0; i < 4; i++) owners.push((await ingest(`+91982220000${i}`)).owner_id);
    expect(owners).toEqual([owners[0], owners[1], owners[0], owners[1]]);
    expect(new Set(owners)).toEqual(new Set([salesG1, salesG2]));

    await db.query("update public.profiles set is_active = false where id = $1", [salesG2]);
    expect((await ingest("+919822200009")).owner_id).toBe(salesG1);
    expect((await ingest("+919822200008")).owner_id).toBe(salesG1);
    await db.query("update public.profiles set is_active = true where id = $1", [salesG2]);

    const visible = await asUser(db, salesG1, (tx) => rows(tx, "select id from public.leads where source = 'facebook'"));
    expect(visible.length).toBeGreaterThanOrEqual(3);
    expect(await asUser(db, salesHub, (tx) => rows(tx, "select id from public.leads where source = 'facebook'"))).toEqual([]);
  });

  it("adds a note to the existing lead for a repeat phone, and fails without a phone", async () => {
    const first = await ingest("+919833300001");
    const repeat = await ingest("+919833300001", { answers: "Wants a quote" });
    expect(repeat).toEqual({ state: "duplicate", lead_id: first.lead_id });
    const note = await one<{ body: string }>(db, "select body from public.lead_activities where lead_id = $1 and type = 'note' order by created_at desc limit 1", [first.lead_id]);
    expect(note.body).toContain('Submitted the Facebook form "Garden design enquiry" again.');

    expect((await ingest("12345")).state).toBe("failed");
    const failed = await one<{ state: string; error: string }>(db, "select state, error from public.meta_lead_events order by created_at desc limit 1");
    expect(failed).toMatchObject({ state: "failed" });
  });

  it("shows the inbox to the super admin", async () => {
    const events = await asUser(db, owner, async (tx) => (await one<{ r: { state: string; owner: string | null }[] }>(tx, "select public.super_meta_events($1) as r", [gardens])).r);
    expect(events.length).toBeGreaterThan(5);
    expect(events.map((e) => e.state)).toContain("duplicate");
    await expect(asUser(db, salesG1, (tx) => tx.query("select public.super_meta_events($1)", [gardens]))).rejects.toThrow(/forbidden/);
  });
});
