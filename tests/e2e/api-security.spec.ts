// Direct REST/RPC calls with each role's real session token: the UI is not the security boundary,
// so these prove the deployed database (RLS, grants, RPC guards) enforces the role matrix.
import { readRun } from "./support/accounts";
import { addFollowUp, createLead, minutesFromNow, phone, tag } from "./support/data";
import { expect, test } from "./support/fixtures";
import { anonClient, userClient } from "./support/supabase";

const rows = (r: { data: unknown; error: unknown }) => (Array.isArray(r.data) ? r.data : r.data ? [r.data] : []);

test.describe("API security (direct database access)", () => {
  const t = tag("API");
  const p = phone();
  let leadA: string;

  test.beforeAll(async () => {
    const run = readRun();
    const salesA = userClient("salesA");
    leadA = (await createLead(salesA, { name: `${t} owned by A`, phone: p, note: `${t} private note` })).id;
    await addFollowUp(salesA, run.ids.salesA, leadA, minutesFromNow(600), `${t} task`);
  });

  test("ROLE-14 anonymous key cannot read any CRM table", async () => {
    const anon = anonClient();
    for (const table of ["leads", "lead_activities", "follow_ups", "profiles", "niches", "expenses", "capital_entries", "finance_activities"] as const) {
      const r = await anon.from(table).select("id").limit(1);
      expect(rows(r), table).toHaveLength(0);
    }
    const rpc = await anon.rpc("list_leads", {});
    expect(rpc.error).not.toBeNull();
  });

  test("ROLE-10 Sales B cannot read or write Sales A's lead, notes or follow-ups", async ({ api }) => {
    const b = api("salesB");
    expect(rows(await b.from("leads").select("id").eq("id", leadA))).toHaveLength(0);
    expect(rows(await b.from("lead_activities").select("id").eq("lead_id", leadA))).toHaveLength(0);
    expect(rows(await b.from("follow_ups").select("id").eq("lead_id", leadA))).toHaveLength(0);

    const note = await b.from("lead_activities").insert({ lead_id: leadA, type: "note", body: "intrusion", actor_id: readRun().ids.salesB } as never);
    expect(note.error).not.toBeNull();
    const upd = await b.from("leads").update({ name: "hijacked" } as never).eq("id", leadA).select("id");
    expect(rows(upd)).toHaveLength(0);

    // Duplicate check reveals that the phone exists, but not which lead.
    const dup = await b.rpc("check_duplicate_phone", { p_phone_normalized: p.e164 });
    expect(dup.data).toMatchObject({ duplicate: true });
    expect((dup.data as { visible_lead_id?: string | null }).visible_lead_id ?? null).toBeNull();
  });

  test("ROLE-11 Sales cannot reassign or archive even their own lead", async ({ api, run }) => {
    const a = api("salesA");
    const reassign = await a.from("leads").update({ owner_id: run.ids.salesB } as never).eq("id", leadA).select("id");
    expect(reassign.error?.message ?? "").toMatch(/forbidden|permission/i);
    const archive = await a.from("leads").update({ archived_at: new Date().toISOString() } as never).eq("id", leadA).select("id");
    expect(archive.error?.message ?? "").toMatch(/forbidden|permission/i);
  });

  test("ROLE-09 Account has no lead, note or follow-up access", async ({ api }) => {
    const acc = api("account");
    expect(rows(await acc.from("leads").select("id").limit(5))).toHaveLength(0);
    expect(rows(await acc.from("lead_activities").select("id").limit(5))).toHaveLength(0);
    expect(rows(await acc.from("follow_ups").select("id").limit(5))).toHaveLength(0);
    expect((await acc.rpc("list_leads", {})).error?.message).toMatch(/forbidden/);
    const create = await acc.rpc("create_lead", { p_name: "x", p_phone: p.display, p_phone_normalized: p.e164, p_new_niche: "x" });
    expect(create.error?.message).toMatch(/forbidden/);
  });

  test("ROLE-07/08 Sales has no finance read or write access", async ({ api, run }) => {
    const s = api("salesA");
    expect(rows(await s.from("expenses").select("id").limit(5))).toHaveLength(0);
    expect(rows(await s.from("capital_entries").select("id").limit(5))).toHaveLength(0);
    expect(rows(await s.from("finance_activities").select("id").limit(5))).toHaveLength(0);
    const ins = await s.from("expenses").insert({ expense_date: "2026-01-01", category: "rent", amount: 1, created_by: run.ids.salesA } as never);
    expect(ins.error).not.toBeNull();
    expect((await s.rpc("dashboard_finance", {})).error?.message).toMatch(/forbidden/);
  });

  test("ROLE-12 Sales and Account cannot manage users or escalate their role", async ({ api, run }) => {
    for (const key of ["salesA", "account"] as const) {
      const c = api(key);
      const self = run.ids[key];
      const direct = await c.from("profiles").update({ role: "admin" } as never).eq("id", self).select("id");
      expect(direct.error, `${key} direct profile update`).not.toBeNull();
      expect((await c.rpc("admin_update_user", { p_user_id: self, p_role: "admin" })).error?.message).toMatch(/forbidden/);
      expect((await c.rpc("admin_list_users", {})).error?.message).toMatch(/forbidden/);
      expect((await c.rpc("dashboard_admin", {})).error?.message).toMatch(/forbidden/);
    }
  });

  test("ROLE-15 Telegram tokens and reminder-worker internals are not reachable by users", async ({ api }) => {
    const a = api("admin");
    expect((await a.from("telegram_link_tokens" as never).select("*").limit(1)).error).not.toBeNull();
    expect((await a.from("reminder_deliveries").select("lease_token").limit(1)).error).not.toBeNull();
    expect((await a.rpc("claim_due_reminders", {})).error).not.toBeNull();
    expect((await a.rpc("consume_telegram_link_token", { p_token: "0".repeat(64), p_chat_id: 1 })).error).not.toBeNull();
  });

  test("PROD-07 deployed list RPC rejects unbounded or injected paging/sort input", async ({ api }) => {
    const s = api("salesA");
    expect((await s.rpc("list_leads", { p_limit: 1000 })).error?.message).toMatch(/invalid_limit/);
    expect((await s.rpc("list_leads", { p_offset: -1 })).error?.message).toMatch(/invalid_offset/);
    expect((await s.rpc("list_leads", { p_sort: "name; drop table public.leads" })).error?.message).toMatch(/invalid_sort/);
    expect((await s.rpc("list_leads", { p_dir: "sideways" })).error?.message).toMatch(/invalid_sort/);
    expect((await s.rpc("list_follow_ups", { p_limit: 101 })).error).not.toBeNull();
  });
});
