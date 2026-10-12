import fs from "node:fs";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/lib/database.types";
import { type AccountKey, type AppRole, storageState } from "./accounts";
import { env } from "./env";

export type Db = SupabaseClient<Database>;

const NO_SESSION = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

/** Bypasses RLS. Test setup, assertions and cleanup only — never used to exercise app behaviour. */
export function serviceClient(): Db {
  return createClient<Database>(env.supabaseUrl, env.secretKey, { auth: NO_SESSION });
}

export function anonClient(): Db {
  return createClient<Database>(env.supabaseUrl, env.publishableKey, { auth: NO_SESSION });
}

const chunkIndex = (cookieName: string) => Number(/\.(\d+)$/.exec(cookieName)?.[1] ?? -1);

/**
 * The signed-in user's access token, read from the Supabase SSR cookie saved by the setup
 * project. Lets tests call the REST API exactly as that browser session would, without
 * spending another sign-in against the Auth rate limit.
 */
export function accessToken(key: AccountKey): string {
  return accessTokenFrom(storageState(key));
}

/** The access token in a saved Playwright storage-state file. */
export function accessTokenFrom(stateFile: string): string {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { cookies: { name: string; value: string }[] };
  const chunks = state.cookies
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => chunkIndex(a.name) - chunkIndex(b.name));
  if (!chunks.length) throw new Error(`No Supabase session cookie in ${stateFile}`);
  let raw = chunks.map((c) => decodeURIComponent(c.value)).join("");
  if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice("base64-".length), "base64url").toString("utf8");
  return (JSON.parse(raw) as { access_token: string }).access_token;
}

/** REST client acting as one of the signed-in test accounts (RLS applies). */
export function userClient(key: AccountKey): Db {
  return tokenClient(accessToken(key));
}

/** REST client for a saved session's access token (RLS applies). */
export function tokenClient(token: string): Db {
  return createClient<Database>(env.supabaseUrl, env.publishableKey, {
    auth: NO_SESSION,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export function authEmail(username: string) {
  return `${username}@${env.loginDomain}`;
}

/** Creates an Auth user + profile exactly like the app's Admin "New user" flow. */
export async function createAuthUser(u: { username: string; displayName: string; role: AppRole; password: string }) {
  const sb = serviceClient();
  // Test users join the oldest company (the one existing data was migrated into).
  const { data: company, error: companyError } = await sb.from("companies").select("id").is("archived_at", null)
    .order("created_at").order("id").limit(1).single();
  if (companyError) throw new Error(`No company: ${companyError.message}`);
  const { data, error } = await sb.auth.admin.createUser({
    email: authEmail(u.username),
    password: u.password,
    email_confirm: true,
    app_metadata: { crm_username: u.username, crm_display_name: u.displayName, crm_role: u.role, crm_company_id: company.id },
  });
  if (error || !data.user) throw new Error(`Could not create ${u.username}: ${error?.message}`);
  return data.user.id;
}

const chunk = <T,>(items: T[], size = 100) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

async function must<T>(label: string, p: PromiseLike<{ error: { message: string } | null; data?: T | null }>) {
  const { error, data } = await p;
  if (error) throw new Error(`cleanup ${label}: ${error.message}`);
  return data as T;
}

/** The test company for the projects module (Star Gardens flow). Reused across runs; never a real company. */
export const E2E_GARDENS = "E2E Gardens";

export async function e2eGardensCompany() {
  const sb = serviceClient();
  const { data } = await sb.from("companies").select("id, features").eq("name", E2E_GARDENS).is("archived_at", null).maybeSingle();
  if (data) {
    if (!data.features.includes("projects")) {
      await must("companies", sb.from("companies").update({ features: [...data.features, "projects"] }).eq("id", data.id));
    }
    return data.id;
  }
  // finance_group_id is filled in by the companies trigger.
  const { data: created, error } = await sb.from("companies").insert({ name: E2E_GARDENS, features: ["projects"] } as never).select("id").single();
  if (error || !created) throw new Error(`Could not create ${E2E_GARDENS}: ${error?.message}`);
  return (created as { id: string }).id;
}

/** Creates an Auth user + profile in E2E Gardens with any role, exactly like the app's "New user" flow. */
export async function createGardensUser(u: { username: string; displayName: string; role: string; password: string }) {
  const companyId = await e2eGardensCompany();
  const { data, error } = await serviceClient().auth.admin.createUser({
    email: authEmail(u.username),
    password: u.password,
    email_confirm: true,
    app_metadata: { crm_username: u.username, crm_display_name: u.displayName, crm_role: u.role, crm_company_id: companyId },
  });
  if (error || !data.user) throw new Error(`Could not create ${u.username}: ${error?.message}`);
  return data.user.id;
}

function tigris() {
  const { TIGRIS_STORAGE_ACCESS_KEY_ID: id, TIGRIS_STORAGE_SECRET_ACCESS_KEY: secret, TIGRIS_STORAGE_BUCKET: bucket } = process.env;
  if (!id || !secret || !bucket) return null;
  const client = new S3Client({
    region: "auto", endpoint: process.env.TIGRIS_STORAGE_ENDPOINT || "https://t3.storage.dev",
    credentials: { accessKeyId: id, secretAccessKey: secret },
  });
  return { client, bucket };
}

/** Deletes E2E Gardens' projects (children cascade), their Tigris objects and site visits. */
async function cleanupE2EProjects(sb: Db) {
  const companies = await must<{ id: string }[]>("companies", sb.from("companies").select("id").eq("name", E2E_GARDENS));
  let projects = 0;
  for (const c of companies) {
    const rows = await must<{ id: string }[]>("projects", sb.from("projects").select("id").eq("company_id", c.id));
    const s3 = tigris();
    for (const p of rows) {
      const versions = await must<{ storage_path: string }[]>("project_file_versions", sb.from("project_file_versions").select("storage_path").eq("project_id", p.id));
      if (s3) {
        const listed = await s3.client.send(new ListObjectsV2Command({ Bucket: s3.bucket, Prefix: `projects/${p.id}/` }));
        const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (keys.length) await s3.client.send(new DeleteObjectsCommand({ Bucket: s3.bucket, Delete: { Objects: keys, Quiet: true } }));
      }
      const names = versions.map((v) => v.storage_path);
      if (names.length) await must("storage_forget_objects", sb.rpc("storage_forget_objects", { p_bucket: "projects", p_names: names }));
    }
    await must("site_visits", sb.from("site_visits").delete().eq("company_id", c.id));
    for (const part of chunk(rows.map((r) => r.id))) await must("projects", sb.from("projects").delete().in("id", part));
    projects += rows.length;
  }
  return projects;
}

/**
 * Hard-deletes every row created by `e2e_*` users, then the users themselves.
 * Real users and their data are never matched.
 */
export async function cleanupE2EData() {
  const sb = serviceClient();
  const projects = await cleanupE2EProjects(sb);
  const profiles = await must<{ id: string }[]>("profiles", sb.from("profiles").select("id").like("username", "e2e\\_%"));
  const ids = profiles.map((p) => p.id);
  if (!ids.length) return { users: 0, projects };

  const leadIds = new Set<string>();
  for (const part of chunk(ids)) {
    for (const col of ["created_by", "owner_id"] as const) {
      const rows = await must<{ id: string }[]>("leads", sb.from("leads").select("id").in(col, part));
      rows.forEach((r) => leadIds.add(r.id));
    }
  }
  for (const part of chunk([...leadIds])) {
    await must("lead_activities", sb.from("lead_activities").delete().in("lead_id", part));
    await must("follow_ups", sb.from("follow_ups").delete().in("lead_id", part)); // reminder_deliveries cascade
    await must("leads", sb.from("leads").delete().in("id", part));
  }

  for (const table of ["expenses", "capital_entries"] as const) {
    for (const part of chunk(ids)) {
      const rows = await must<{ id: string }[]>(table, sb.from(table).select("id").in("created_by", part));
      for (const rowPart of chunk(rows.map((r) => r.id))) {
        await must("finance_activities", sb.from("finance_activities").delete().in("entity_id", rowPart));
        await must(table, sb.from(table).delete().in("id", rowPart));
      }
    }
  }
  // Monthly series (their expenses were deleted above) and queued Telegram notifications.
  for (const part of chunk(ids)) {
    await must("expense_recurrences", sb.from("expense_recurrences").delete().in("created_by", part));
    await must("telegram_notifications", sb.from("telegram_notifications").delete().in("recipient_id", part));
  }
  for (const part of chunk(ids)) {
    await must("finance_activities", sb.from("finance_activities").delete().in("actor_id", part));
    await must("lead_activities", sb.from("lead_activities").delete().in("actor_id", part));
  }

  const niches = (await Promise.all(chunk(ids).map((part) => must<{ id: string }[]>("niches", sb.from("niches").select("id").in("created_by", part))))).flat();
  for (const part of chunk(niches.map((n) => n.id))) {
    await must("niches", sb.from("niches").update({ merged_into_id: null } as never).in("merged_into_id", part));
  }
  for (const n of niches) {
    // A real lead may have picked an e2e niche during the run; keep it and just detach the author.
    const { error } = await sb.from("niches").delete().eq("id", n.id);
    if (error) await sb.from("niches").update({ created_by: null } as never).eq("id", n.id);
  }

  for (const part of chunk(ids)) {
    await must("admin_audit_log", sb.from("admin_audit_log").delete().in("actor_id", part));
    await must("admin_audit_log", sb.from("admin_audit_log").delete().in("target_user_id", part));
  }
  for (const id of ids) {
    const { error } = await sb.auth.admin.deleteUser(id);
    if (error) throw new Error(`cleanup auth user ${id}: ${error.message}`);
  }
  return { users: ids.length, leads: leadIds.size, niches: niches.length, projects };
}
