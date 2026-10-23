#!/usr/bin/env node
// Times the reads the Dashboard, Leads, Follow-ups and lead pages make, as the perf_* users (RLS applies).
// Usage: pnpm perf:measure --logins <file from perf:sandbox> [--runs 10] [--out result.json] [--compare before.json]
//
// Read-only: it signs in and calls the same RPCs/selects the browser does, nothing else.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

const { values } = parseArgs({
  options: { logins: { type: "string" }, runs: { type: "string", default: "10" }, out: { type: "string" }, compare: { type: "string" } },
});
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const domain = process.env.AUTH_LOGIN_DOMAIN;
if (!url || !publishable || !domain || !values.logins) {
  console.error("Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, AUTH_LOGIN_DOMAIN and --logins <file>.");
  process.exit(1);
}
const RUNS = Number(values.runs);
const logins = JSON.parse(readFileSync(values.logins, "utf8"));

const IST_OFFSET = 5.5 * 3_600_000;
const istDate = (ms) => new Date(ms + IST_OFFSET).toISOString().slice(0, 10);
const today = istDate(Date.now());
const monthAgo = istDate(Date.now() - 29 * 86_400_000);

async function signIn(username, password) {
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: `${username}@${domain}`, password });
  if (error) throw new Error(`sign in ${username}: ${error.message}`);
  return { client, uid: data.user.id };
}

const leadsArgs = (over = {}) => ({
  p_overdue_only: false, p_archived: false, p_sort: "created_at", p_dir: "desc", p_limit: 50, p_offset: 0, p_starred_only: false, ...over,
});
const fuArgs = (view, over = {}) => ({ p_view: view, p_limit: 20, p_offset: 0, ...over });

function cases(c, uid, role, leadId, stageId) {
  const rpc = (fn, args) => () => c.rpc(fn, args);
  const list = {
    "baseline: tiny select (network)": () => c.from("pipeline_stages").select("id").limit(1),
    "shell: profiles (me)": () => c.from("profiles").select("id, username, display_name, role, extra_roles, is_active").eq("id", uid).maybeSingle(),
    "shell: companies": () => c.from("companies").select("id, name, brand_highlight, logo_path, features, parent_company_id").is("archived_at", null).order("created_at").order("id"),
    "shell: my_context": rpc("my_context"),
    "shell: pipeline_stages": () => c.from("pipeline_stages").select("id, name, position, kind, color, archived_at").order("position").order("id"),
    "shell: my_notifications": rpc("my_notifications", { p_unread_only: false, p_limit: 20, p_offset: 0 }),
    "leads: default page 1": rpc("list_leads", leadsArgs()),
    "leads: search 'Lead 15'": rpc("list_leads", leadsArgs({ p_search: "Lead 15" })),
    "leads: search phone": rpc("list_leads", leadsArgs({ p_search: "98700012" })),
    "leads: stage filter": rpc("list_leads", leadsArgs({ p_stage_ids: [stageId] })),
    "leads: overdue only": rpc("list_leads", leadsArgs({ p_overdue_only: true })),
    "leads: page 20": rpc("list_leads", leadsArgs({ p_offset: 950 })),
    "leads: sort next follow-up": rpc("list_leads", leadsArgs({ p_sort: "next_follow_up", p_dir: "asc" })),
    "leads: sort name": rpc("list_leads", leadsArgs({ p_sort: "name", p_dir: "asc" })),
    "leads: sort stage": rpc("list_leads", leadsArgs({ p_sort: "status", p_dir: "asc" })),
    "follow-ups: overdue": rpc("list_follow_ups", fuArgs("overdue")),
    "follow-ups: today": rpc("list_follow_ups", fuArgs("today")),
    "follow-ups: upcoming": rpc("list_follow_ups", fuArgs("upcoming")),
    "follow-ups: completed": rpc("list_follow_ups", fuArgs("completed")),
    "follow-ups: search": rpc("list_follow_ups", fuArgs("upcoming", { p_search: "Lead 15" })),
    "lead page: lead": () => c.from("leads").select(
      "id, name, company_name, phone, phone_normalized, email, status, stage_id, temperature, source, source_meta, version, created_at, updated_at, archived_at, owner_id, " +
      "niche:niches!leads_niche_id_fkey(id, name), owner:profiles!leads_owner_id_fkey(id, display_name), creator:profiles!leads_created_by_fkey(display_name), " +
      "stars:lead_stars(pinned_at), handoff_at, handoff_note, projects(id, code)").eq("id", leadId).maybeSingle(),
    "lead page: follow-ups": () => c.from("follow_ups")
      .select("id, task, due_at, state, revision, assignee:profiles!follow_ups_assignee_id_fkey(display_name), reminder_deliveries(revision, state, attempts, last_error, sent_at)")
      .eq("lead_id", leadId).eq("state", "pending").order("due_at").order("id").limit(20),
    "lead page: timeline": () => c.from("lead_activities")
      .select("id, type, body, meta, created_at, edited_at, follow_up_id, actor_id, actor:profiles!lead_activities_actor_id_fkey(display_name)")
      .eq("lead_id", leadId).order("created_at", { ascending: false }).order("id", { ascending: false }).range(0, 20),
  };
  if (role === "admin") {
    list["dashboard: dashboard_admin"] = rpc("dashboard_admin", { p_from: monthAgo, p_to: today });
    list["leads: lead_export_pending"] = rpc("lead_export_pending");
    list["leads: list_lead_staff"] = rpc("list_lead_staff");
  } else {
    list["dashboard: dashboard_sales"] = rpc("dashboard_sales", { p_from: monthAgo, p_to: today });
  }
  return list;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function time(fn) {
  const t = performance.now();
  const { error } = await fn();
  const ms = performance.now() - t;
  if (error) throw new Error(error.message);
  return ms;
}

const results = {};
for (const key of ["admin", "salesA"]) {
  const u = logins.users[key];
  const { client, uid } = await signIn(u.username, u.password);
  const { data: lead } = await client.from("leads").select("id").order("created_at", { ascending: false }).limit(1).single();
  const { data: stage } = await client.from("pipeline_stages").select("id").eq("kind", "open").order("position").limit(1).single();
  const role = key === "admin" ? "admin" : "sales";
  for (const [name, fn] of Object.entries(cases(client, uid, role, lead.id, stage.id))) {
    const label = `${u.username} · ${name}`;
    try {
      await time(fn); // warm-up (connection, plan cache)
      const samples = [];
      for (let i = 0; i < RUNS; i++) samples.push(await time(fn));
      samples.sort((a, b) => a - b);
      results[label] = { median: Math.round(pct(samples, 50)), p95: Math.round(pct(samples, 95)) };
    } catch (e) {
      results[label] = { error: e.message };
    }
  }
  await client.auth.signOut();
}

const before = values.compare ? JSON.parse(readFileSync(values.compare, "utf8")) : null;
const width = Math.max(...Object.keys(results).map((k) => k.length));
console.log(`${"query".padEnd(width)}  median    p95${before ? "   before (median)" : ""}`);
for (const [k, r] of Object.entries(results)) {
  if (r.error) {
    console.log(`${k.padEnd(width)}  ERROR ${r.error}`);
    continue;
  }
  const b = before?.[k]?.median;
  console.log(`${k.padEnd(width)}  ${String(r.median).padStart(5)} ms ${String(r.p95).padStart(5)} ms${b !== undefined ? `   ${String(b).padStart(5)} ms` : ""}`);
}
if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 2));
