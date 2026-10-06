#!/usr/bin/env node
// One-time creation of the FIRST Admin. Refuses to run if an active Admin exists.
// Usage: pnpm bootstrap:admin --username owner --name "Owner Name"
// Password: BOOTSTRAP_ADMIN_PASSWORD env var, or typed at a hidden prompt. Never pass it as an argument.
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

const { values } = parseArgs({ options: { username: { type: "string" }, name: { type: "string" } } });
const username = (values.username ?? "").trim().toLowerCase();
const displayName = (values.name ?? "").trim();
if (!/^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/.test(username) || !displayName) {
  console.error('Usage: --username <3-32 chars a-z 0-9 . _ -> --name "Display Name"');
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const domain = process.env.AUTH_LOGIN_DOMAIN;
if (!url || !secret || !domain) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY or AUTH_LOGIN_DOMAIN (use --env-file=.env.local).");
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
  });
}

const supabase = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: admins, error: adminErr } = await supabase.from("profiles").select("id").in("role", ["admin", "super_admin"]).eq("is_active", true).limit(1);
if (adminErr) {
  console.error("Could not read profiles. Are the migrations applied?", adminErr.message);
  process.exit(1);
}
if (admins.length > 0) {
  console.error("An active admin already exists. Create further users from the CRM's Users page.");
  process.exit(1);
}

let password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!password) {
  password = await promptHidden("Password for the first admin (min 8 chars): ");
  const again = await promptHidden("Repeat password: ");
  if (password !== again) {
    console.error("Passwords do not match.");
    process.exit(1);
  }
}
if (!password || password.length < 8 || password.length > 72) {
  console.error("Password must be 8-72 characters.");
  process.exit(1);
}

const { data, error } = await supabase.auth.admin.createUser({
  email: `${username}@${domain}`,
  password,
  email_confirm: true,
  // The first account is the super admin: it creates companies and works in any of them.
  app_metadata: { crm_username: username, crm_display_name: displayName, crm_role: "super_admin" },
});
if (error || !data.user) {
  console.error("Could not create the user:", error?.message ?? "unknown error");
  process.exit(1);
}
const { data: profile } = await supabase.from("profiles").select("id, role").eq("id", data.user.id).maybeSingle();
if (!profile) {
  await supabase.auth.admin.deleteUser(data.user.id);
  console.error("Profile was not created (is the on_auth_user_created trigger migrated?). The Auth user was rolled back.");
  process.exit(1);
}
console.log(`Super admin created. Sign in with username "${username}".`);
