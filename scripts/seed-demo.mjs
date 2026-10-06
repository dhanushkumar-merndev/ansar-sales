#!/usr/bin/env node
// Demo data (~1,000 leads, follow-ups, expenses and capital entries with history) for trying the CRM and its reports.
// Usage: pnpm seed:demo            add the demo data
//        pnpm seed:demo --clean    remove it again (real data is never touched)
//
// Everything belongs to demo_* users, which are created inactive with random passwords that are never shown,
// so nobody can sign in as them. The SQL runs through the Supabase CLI against the linked project.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

const { values } = parseArgs({ options: { clean: { type: "boolean", default: false } } });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const domain = process.env.AUTH_LOGIN_DOMAIN;
if (!url || !secret || !domain) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY or AUTH_LOGIN_DOMAIN.");
  process.exit(1);
}

const USERS = [
  { username: "demo_sales_1", displayName: "Demo Sales 1", role: "sales" },
  { username: "demo_sales_2", displayName: "Demo Sales 2", role: "sales" },
  { username: "demo_sales_3", displayName: "Demo Sales 3", role: "sales" },
  { username: "demo_sales_4", displayName: "Demo Sales 4 (left)", role: "sales" },
  { username: "demo_account", displayName: "Demo Account", role: "account" },
];

const sb = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const sqlFile = (name) => join(import.meta.dirname, "..", "supabase", "seed", name);

function runSql(file) {
  const out = execFileSync("npx", ["--no-install", "supabase", "db", "query", "--linked", "-f", file], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const rows = out.match(/\{[\s\S]*\}/)?.[0];
  console.log(rows ? JSON.stringify(JSON.parse(rows).rows ?? JSON.parse(rows), null, 2) : out.trim());
}

async function demoProfiles() {
  const { data, error } = await sb.from("profiles").select("id, username").like("username", "demo\\_%");
  if (error) throw error;
  return data;
}

if (values.clean) {
  runSql(sqlFile("demo-clean.sql"));
  for (const p of await demoProfiles()) {
    const { error } = await sb.auth.admin.deleteUser(p.id);
    if (error) throw new Error(`Could not delete ${p.username}: ${error.message}`);
  }
  console.log("Demo data and demo users removed.");
  process.exit(0);
}

// Demo users (and so the demo data) go into the oldest company.
const { data: company, error: companyError } = await sb.from("companies").select("id, name").is("archived_at", null)
  .order("created_at").order("id").limit(1).single();
if (companyError) throw companyError;
console.log(`Demo data goes into: ${company.name}`);

const existing = new Set((await demoProfiles()).map((p) => p.username));
for (const u of USERS.filter((u) => !existing.has(u.username))) {
  const { error } = await sb.auth.admin.createUser({
    email: `${u.username}@${domain}`,
    password: randomBytes(24).toString("base64url"),
    email_confirm: true,
    app_metadata: { crm_username: u.username, crm_display_name: u.displayName, crm_role: u.role, crm_company_id: company.id },
  });
  if (error) throw new Error(`Could not create ${u.username}: ${error.message}`);
}
const { error } = await sb.from("profiles").update({ is_active: false }).like("username", "demo\\_%");
if (error) throw error;

runSql(sqlFile("demo.sql"));
console.log("Demo data added. Remove it any time with: pnpm seed:demo --clean");
