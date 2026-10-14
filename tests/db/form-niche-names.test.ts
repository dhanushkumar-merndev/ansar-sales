import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createUser, defaultCompany, nextPhone, one, rows, type Db } from "./harness";

let db: Db;
let hub: string, admin: string;

const clean = async (name: string | null) =>
  (await one<{ r: string | null }>(db, "select private.form_niche_name($1) as r", [name])).r;

let n = 0;
const ingest = (form: string) => asService(db, async (tx) => (await one<{ r: { lead_id: string } }>(tx,
  "select public.ingest_meta_lead(p_company_id => $1, p_leadgen_id => $2, p_name => 'Ad lead', p_phone => $3, p_phone_normalized => $3, p_form_name => $4) as r",
  [hub, `niche-${++n}`, nextPhone(), form])).r);
const nicheOf = async (lead: string) =>
  (await one<{ name: string }>(db, "select n.name from public.leads l join public.niches n on n.id = l.niche_id where l.id = $1", [lead])).name;

const addNiche = async (name: string) =>
  (await one<{ id: string }>(db, "insert into public.niches (company_id, name) values ($1, $2) returning id", [hub, name])).id;
const addLead = async (niche: string, source: string) => {
  const phone = nextPhone();
  return (await one<{ id: string }>(db,
    `insert into public.leads (company_id, name, phone, phone_normalized, niche_id, owner_id, created_by, source)
     values ($1, 'Old lead', $2, $2, $3, $4, $4, $5) returning id`, [hub, phone, niche, admin, source])).id;
};

beforeAll(async () => {
  db = await createDb();
  hub = await defaultCompany(db);
  admin = await createUser(db, "niche_admin", "admin");
});

describe("niche name from a Facebook form name", () => {
  it.each([
    ["FORM 2 - PROSPECTING CRM - JULY 22", "PROSPECTING CRM"],
    ["FORM - PROSPECTING CRM - AUG 25", "PROSPECTING CRM"],
    ["FORM 2.1 - HOSPITAL CRM - JULY 22", "HOSPITAL CRM"],
    ["LANDSCAPE ARCHITECT_OCT 10-copy", "LANDSCAPE ARCHITECT"],
    ["Villa enquiry - 13/10/2026, 14:22", "Villa enquiry"],
    ["Interior design 5th March 2026", "Interior design"],
    ["Real estate (copy 2)", "Real estate"],
    // Words that merely start like a month, and names that are only a date, are kept.
    ["Digital Marketing", "Digital Marketing"],
    ["Formal wear - Sale", "Formal wear - Sale"],
    ["JULY 22", "JULY 22"],
  ])("%s → %s", async (form, niche) => {
    expect(await clean(form)).toBe(niche);
  });

  it("is null for no form name", async () => {
    expect(await clean(null)).toBeNull();
    expect(await clean("   ")).toBeNull();
  });

  it("puts leads of dated forms for the same product in one niche", async () => {
    const a = await ingest("FORM 2 - SOLAR CRM - JULY 22");
    const b = await ingest("FORM - SOLAR CRM - AUG 25");
    expect(await nicheOf(a.lead_id)).toBe("SOLAR CRM");
    expect(await nicheOf(b.lead_id)).toBe("SOLAR CRM");
    const [{ count }] = await rows<{ count: number }>(db,
      "select count(*)::int as count from public.niches where company_id = $1 and normalized_name like '%solar%'", [hub]);
    expect(count).toBe(1);
  });
});

describe("cleaning existing niches", () => {
  it("renames Facebook niches, merges ones that end up the same and leaves typed niches alone", async () => {
    const july = await addNiche("FORM 2 - REALESTATE CRM - JULY 22");
    const aug = await addNiche("FORM 3 - REALESTATE CRM - AUG 1");
    const typed = await addNiche("Retail 2024 - JULY 22");
    const l1 = await addLead(july, "facebook");
    const l2 = await addLead(aug, "facebook");
    const l3 = await addLead(typed, "manual");

    expect((await one<{ r: number }>(db, "select private.clean_form_niches() as r")).r).toBe(2);

    expect(await nicheOf(l1)).toBe("REALESTATE CRM");
    expect(await nicheOf(l2)).toBe("REALESTATE CRM");
    expect(await nicheOf(l3)).toBe("Retail 2024 - JULY 22");
    const merged = await one<{ archived: boolean; merged_into_id: string }>(db,
      "select archived_at is not null as archived, merged_into_id from public.niches where id = $1", [aug]);
    expect(merged).toEqual({ archived: true, merged_into_id: july });
    // The merge is on the lead's timeline.
    const activity = await one<{ meta: { changes: { Niche: { from: string; to: string } } } }>(db,
      "select meta from public.lead_activities where lead_id = $1 and type = 'lead_updated'", [l2]);
    expect(activity.meta.changes.Niche).toEqual({ from: "FORM 3 - REALESTATE CRM - AUG 1", to: "REALESTATE CRM" });
  });

  it("is not callable by users", async () => {
    await expect(asUser(db, admin, (tx) => tx.query("select private.clean_form_niches()"))).rejects.toThrow(/permission denied/);
  });
});
