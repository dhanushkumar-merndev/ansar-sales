#!/usr/bin/env node
// Throwaway company with ~3,000 leads and ~6,000 follow-ups for timing the Dashboard, Leads and Follow-ups pages.
// Usage: pnpm perf:sandbox --setup --logins <file>   create "ZZ Perf Test", its perf_* logins and the data
//        pnpm perf:sandbox --setup --resume --logins <file>   continue after a failed batch (same file)
//        pnpm perf:sandbox --clean                   delete all of it, the logins and the company again
//
// Real companies are never written to: everything is scoped to the ZZ Perf Test company and the perf_* users.
// Leads go through import_leads (one summary alert per --batch to super admins, as with an Excel import).
// The passwords are written only to the --logins file, which must be outside the repo.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

const { values } = parseArgs({
  options: {
    setup: { type: "boolean", default: false }, resume: { type: "boolean", default: false }, clean: { type: "boolean", default: false }, logins: { type: "string" },
    leads: { type: "string", default: "3000" }, batch: { type: "string", default: "400" },
  },
});
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const domain = process.env.AUTH_LOGIN_DOMAIN;
if (!url || !secret || !publishable || !domain) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY or AUTH_LOGIN_DOMAIN.");
  process.exit(1);
}
if (values.setup === values.clean) {
  console.error("Pass exactly one of --setup or --clean.");
  process.exit(1);
}

const COMPANY = "ZZ Perf Test";
const LEADS = Number(values.leads);
// import_leads runs in one statement: 500 rows passed the 8 s statement timeout on the live project.
const BATCH = Number(values.batch);
const USERS = [
  { key: "admin", username: "perf_admin", displayName: "Perf Admin", role: "admin" },
  { key: "salesA", username: "perf_sales_a", displayName: "Perf Sales A", role: "sales" },
  { key: "salesB", username: "perf_sales_b", displayName: "Perf Sales B", role: "sales" },
];
const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const sb = createClient(url, secret, { auth: NO_SESSION });

const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

async function must(label, p) {
  const { data, error, count } = await p;
  if (error) throw new Error(`${label}: ${error.message}`);
  return count ?? data;
}

/** Runs fn over items with a few requests in flight at once. */
async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

const countOf = (table, filter = (q) => q) => must(`count ${table}`, filter(sb.from(table).select("*", { count: "exact", head: true })));

async function perfCompany() {
  const rows = await must("companies", sb.from("companies").select("id").eq("name", COMPANY));
  return rows[0]?.id ?? null;
}

async function perfProfiles() {
  return must("profiles", sb.from("profiles").select("id, username").like("username", "perf\\_%"));
}

/** Lead counts of every other company, plus global totals, to prove real data was not touched. */
async function snapshot(skipCompany) {
  const companies = await must("companies", sb.from("companies").select("id, name").order("name"));
  const out = {};
  for (const c of companies) {
    if (c.id === skipCompany) continue;
    out[`leads · ${c.name}`] = await countOf("leads", (q) => q.eq("company_id", c.id));
  }
  for (const t of ["follow_ups", "lead_activities", "telegram_notifications", "app_notifications", "profiles"]) out[t] = await countOf(t);
  return out;
}

function printDiff(before, after) {
  for (const k of Object.keys(before)) {
    const d = after[k] - before[k];
    console.log(`  ${k.padEnd(40)} ${String(before[k]).padStart(7)} → ${String(after[k]).padStart(7)}${d ? `  (${d > 0 ? "+" : ""}${d})` : ""}`);
  }
}

async function signIn(username, password) {
  const client = createClient(url, publishable, { auth: NO_SESSION });
  const { error } = await client.auth.signInWithPassword({ email: `${username}@${domain}`, password });
  if (error) throw new Error(`sign in ${username}: ${error.message}`);
  return client;
}

async function setup() {
  if (!values.logins) throw new Error("--logins <file outside the repo> is required for --setup.");
  const before = await snapshot(null);
  const logins = values.resume ? JSON.parse(readFileSync(values.logins, "utf8")) : await createCompanyAndLogins();
  const company = { id: logins.companyId };
  const admin = await signIn("perf_admin", logins.users.admin.password);
  const stages = await must("stages", sb.from("pipeline_stages").select("id, kind").eq("company_id", company.id).order("position"));
  const open = stages.filter((s) => s.kind !== "won" && s.kind !== "lost");
  const won = stages.find((s) => s.kind === "won");
  const lost = stages.find((s) => s.kind === "lost");
  const owners = [logins.users.salesA.id, logins.users.salesB.id];

  const rows = Array.from({ length: LEADS }, (_, i) => {
    const n = String(i + 1).padStart(4, "0");
    const phone = `+9198${String(70000000 + i).padStart(8, "0")}`;
    const r = i % 20;
    const stage = r === 0 ? won : r === 1 ? lost : open[i % open.length];
    return {
      name: `[PERF] Lead ${n}`, phone, phone_normalized: phone,
      email: i % 3 === 0 ? `perf${n}@example.com` : undefined,
      company_name: i % 4 === 0 ? `Perf Business ${n}` : undefined,
      new_niche: `[PERF] Niche ${String((i % 15) + 1).padStart(2, "0")}`,
      stage_id: stage?.id, owner_id: owners[i % 3 === 2 ? 1 : 0],
      note: i % 2 === 0 ? `Perf test note for lead ${n}.` : undefined,
    };
  });
  // On --resume, keep the leads already imported and continue after them.
  const leadIds = [];
  for (let from = 0; ; from += 1000) {
    const page = await must("leads", sb.from("leads").select("id").eq("company_id", company.id).order("created_at").order("id").range(from, from + 999));
    leadIds.push(...page.map((r) => r.id));
    if (page.length < 1000) break;
  }
  if (leadIds.length && !values.resume) throw new Error("The new company already has leads.");
  for (const [b, batch] of chunk(rows.slice(leadIds.length), BATCH).entries()) {
    const started = Date.now();
    const result = await must(`import batch ${b + 1}`, admin.rpc("import_leads", { p_rows: batch, p_allow_duplicates: true }));
    const failed = result.filter((r) => r.error);
    if (failed.length) throw new Error(`import batch ${b + 1}: ${failed.length} rows failed (first: ${failed[0].error})`);
    leadIds.push(...result.map((r) => r.id));
    console.log(`  imported ${leadIds.length}/${LEADS} leads (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  }

  // Two follow-ups per lead, due 3–45 days ahead so the reminder worker has nothing to send meanwhile.
  const day = 86_400_000;
  const fuRows = leadIds.flatMap((id, i) => [0, 1].map((k) => ({
    lead_id: id, task: k ? "Send the proposal" : "Call back about pricing",
    due_at: new Date(Date.now() + (3 + ((i * 7 + k * 13) % 43)) * day + (i % 24) * 3_600_000).toISOString(),
    created_by: logins.users.admin.id,
  })));
  const fuIds = [];
  for (const batch of chunk(fuRows, 500)) {
    const ids = await must("follow-ups", admin.from("follow_ups").insert(batch).select("id"));
    fuIds.push(...ids.map((r) => r.id));
    console.log(`  scheduled ${fuIds.length}/${fuRows.length} follow-ups`);
  }

  // Half get completed with an outcome (timeline history), the way staff complete them.
  const toComplete = fuIds.filter((_, i) => i % 2 === 1);
  let done = 0;
  await pool(toComplete, 8, async (id) => {
    await must("complete", admin.rpc("complete_follow_up", { p_id: id, p_outcome: "Spoke to them; follow up later." }));
    if (++done % 500 === 0) console.log(`  completed ${done}/${toComplete.length} follow-ups`);
  });

  // A few overdue tasks: move them into the past, then cancel their reminder rows so nothing is sent.
  const overdue = fuIds.filter((_, i) => i % 2 === 0).slice(0, 120);
  for (const [i, id] of overdue.entries()) {
    await must("overdue", sb.from("follow_ups").update({ due_at: new Date(Date.now() - (1 + (i % 10)) * day).toISOString() }).eq("id", id));
  }
  for (const part of chunk(overdue, 100)) {
    await must("cancel reminders", sb.from("reminder_deliveries").update({ state: "cancelled", last_error: "perf_sandbox", lease_token: null })
      .in("follow_up_id", part).eq("state", "pending"));
  }
  console.log(`  moved ${overdue.length} follow-ups into the past (reminders cancelled)`);

  console.log("\nCounts before → after (other companies must not change; super admins get the import summaries):");
  printDiff(before, await snapshot(company.id));
}

async function createCompanyAndLogins() {
  if ((await perfCompany()) || (await perfProfiles()).length) throw new Error(`${COMPANY} or perf_* users already exist. Run --clean first.`);
  // finance_group_id and the default pipeline stages are filled in by the companies triggers.
  const company = await must("create company", sb.from("companies").insert({ name: COMPANY }).select("id").single());
  console.log(`Created company ${COMPANY} (${company.id}).`);
  const logins = { company: COMPANY, companyId: company.id, users: {} };
  for (const u of USERS) {
    const password = `Perf-${randomBytes(12).toString("base64url")}`;
    const { data, error } = await sb.auth.admin.createUser({
      email: `${u.username}@${domain}`, password, email_confirm: true,
      app_metadata: { crm_username: u.username, crm_display_name: u.displayName, crm_role: u.role, crm_company_id: company.id },
    });
    if (error || !data.user) throw new Error(`create ${u.username}: ${error?.message}`);
    logins.users[u.key] = { id: data.user.id, username: u.username, password };
  }
  writeFileSync(values.logins, JSON.stringify(logins, null, 2), { mode: 0o600 });
  console.log(`Created ${USERS.length} logins (passwords in ${values.logins}).`);
  return logins;
}

async function clean() {
  const companyId = await perfCompany();
  const users = await perfProfiles();
  const ids = users.map((u) => u.id);
  const before = await snapshot(companyId);

  if (companyId) {
    const leads = [];
    for (let from = 0; ; from += 1000) {
      const page = await must("leads", sb.from("leads").select("id").eq("company_id", companyId).range(from, from + 999));
      leads.push(...page.map((r) => r.id));
      if (page.length < 1000) break;
    }
    for (const part of chunk(leads, 100)) {
      await must("lead_activities", sb.from("lead_activities").delete().in("lead_id", part));
      await must("follow_ups", sb.from("follow_ups").delete().in("lead_id", part)); // reminder_deliveries cascade
      await must("leads", sb.from("leads").delete().in("id", part)); // their app notifications go with them
    }
    console.log(`Deleted ${leads.length} leads with their follow-ups and timeline.`);
    // Import summaries sent to super admins name the company.
    await must("telegram_notifications", sb.from("telegram_notifications").delete().eq("payload->>company_id", companyId));
    await must("app_notifications", sb.from("app_notifications").delete().eq("payload->>company_id", companyId));
  }
  for (const part of chunk(ids, 100)) {
    await must("telegram_notifications", sb.from("telegram_notifications").delete().in("recipient_id", part));
    await must("app_notifications", sb.from("app_notifications").delete().in("recipient_id", part));
    await must("lead_activities", sb.from("lead_activities").delete().in("actor_id", part));
    await must("admin_audit_log", sb.from("admin_audit_log").delete().in("actor_id", part));
    await must("admin_audit_log", sb.from("admin_audit_log").delete().in("target_user_id", part));
  }
  if (companyId) await must("niches", sb.from("niches").delete().eq("company_id", companyId));
  for (const u of users) {
    const { error } = await sb.auth.admin.deleteUser(u.id);
    if (error) throw new Error(`delete login ${u.username}: ${error.message}`);
  }
  console.log(`Deleted ${users.length} perf_* logins.`);

  if (companyId) {
    const { data: group } = await sb.from("companies").select("finance_group_id").eq("id", companyId).single();
    await must("pipeline_stages", sb.from("pipeline_stages").delete().eq("company_id", companyId));
    await must("company", sb.from("companies").delete().eq("id", companyId));
    if (group?.finance_group_id) {
      const { error } = await sb.from("finance_groups").delete().eq("id", group.finance_group_id);
      if (error) console.log(`  finance group kept (${error.message})`);
    }
    console.log(`Deleted company ${COMPANY}.`);
  }

  const left = { company: await perfCompany(), users: (await perfProfiles()).length };
  if (left.company || left.users) throw new Error(`Something is left: ${JSON.stringify(left)}`);
  console.log("\nCounts before → after (other companies must not change):");
  printDiff(before, await snapshot(null));
}

try {
  await (values.setup ? setup() : clean());
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
