#!/usr/bin/env node
// Star Gardens demo data: 24 leads, 13 projects (SG-DEMO-01…13) with timelines, files in nested folders, site visits,
// BOQ, payments, bell notifications, two client portal logins, and every edge case we know of (see supabase/seed/star-gardens.sql).
//
// Usage: pnpm seed:star-gardens             add it (demo users can't sign in)
//        pnpm seed:star-gardens --logins    add it, and let you sign in as each demo role (one shared password, shown once)
//        pnpm seed:star-gardens --clean     remove all of it again (real data is never touched)
//
// Needs every project migration (up to 20261008001600) on the linked project. The SQL runs through the Supabase CLI;
// small placeholder files are uploaded to Tigris so previews and downloads open.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { deflateSync } from "node:zlib";
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

const { values } = parseArgs({ options: { clean: { type: "boolean", default: false }, logins: { type: "boolean", default: false } } });
const need = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY", "AUTH_LOGIN_DOMAIN", "TIGRIS_STORAGE_ACCESS_KEY_ID", "TIGRIS_STORAGE_SECRET_ACCESS_KEY", "TIGRIS_STORAGE_BUCKET"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}.`);
  process.exit(1);
}
const domain = process.env.AUTH_LOGIN_DOMAIN;
const bucket = process.env.TIGRIS_STORAGE_BUCKET;

// Main role, extra roles. demo_sg_bdm2 and demo_sg_ld3 have "left" and are always switched off.
const USERS = [
  { username: "demo_sg_admin", displayName: "Demo Admin (also Accounts)", role: "admin", extra: ["account"] },
  { username: "demo_sg_bdm1", displayName: "Demo BDM Priya", role: "sales" },
  { username: "demo_sg_bdm2", displayName: "Demo BDM Arjun (left)", role: "sales", inactive: true },
  { username: "demo_sg_am1", displayName: "Demo Raj (Architect manager)", role: "architect_manager" },
  { username: "demo_sg_am2", displayName: "Demo Meera (Architect manager + designer)", role: "architect_manager", extra: ["landscape_designer"] },
  { username: "demo_sg_ld1", displayName: "Demo Diny (Designer)", role: "landscape_designer" },
  { username: "demo_sg_ld2", displayName: "Demo Kiran (Designer + execution)", role: "landscape_designer", extra: ["execution"] },
  { username: "demo_sg_ld3", displayName: "Demo Sanjay (Designer, left)", role: "landscape_designer", inactive: true },
  { username: "demo_sg_ex1", displayName: "Demo Abhi (Execution manager)", role: "execution" },
  { username: "demo_sg_acc", displayName: "Demo Lakshmi (Accounts)", role: "account" },
];
const CLIENTS = [
  { username: "demo_sg_client_hari", displayName: "Mr. Hari Prasad (demo client)", project: "SG-DEMO-01" },
  { username: "demo_sg_client_villa", displayName: "Mrs. Kavya Menon (demo client)", project: "SG-DEMO-02", inactive: true },
];

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const s3 = new S3Client({
  region: "auto", endpoint: process.env.TIGRIS_STORAGE_ENDPOINT || "https://t3.storage.dev",
  credentials: { accessKeyId: process.env.TIGRIS_STORAGE_ACCESS_KEY_ID, secretAccessKey: process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY },
});
const sqlFile = (name) => join(import.meta.dirname, "..", "supabase", "seed", name);

/** The Supabase CLI from the project, from PATH, or fetched by pnpm. */
function runSql(file) {
  const args = ["db", "query", "--linked", "-f", file];
  const attempts = [["npx", ["--no-install", "supabase", ...args]], ["supabase", args], ["pnpm", ["dlx", "supabase", ...args]]];
  let lastError;
  for (const [cmd, a] of attempts) {
    try {
      const out = execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const rows = out.match(/\{[\s\S]*\}/)?.[0];
      console.log(rows ? JSON.stringify(JSON.parse(rows).rows ?? JSON.parse(rows), null, 2) : out.trim());
      return;
    } catch (e) {
      lastError = e;
      // Not installed: try the next way. A SQL error: stop.
      if (e.code !== "ENOENT" && !/could not determine executable|not found|command not found|missing packages/i.test(String(e.stderr))) break;
    }
  }
  throw new Error(`SQL ${file} failed:\n${lastError?.stderr || lastError?.message}`);
}

async function profilesLike(prefix) {
  const { data, error } = await sb.from("profiles").select("id, username").like("username", `${prefix}%`);
  if (error) throw error;
  return data;
}

async function demoProjects() {
  const { data, error } = await sb.from("projects").select("id, code").like("code", "SG-DEMO-%");
  if (error) throw error;
  return data;
}

async function deleteStoredFiles() {
  const projects = await demoProjects();
  for (const p of projects) {
    const { data: versions } = await sb.from("project_file_versions").select("storage_path").eq("project_id", p.id);
    let token;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `projects/${p.id}/`, ContinuationToken: token }));
      const keys = (r.Contents ?? []).map((o) => ({ Key: o.Key }));
      if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
      token = r.NextContinuationToken;
    } while (token);
    const names = (versions ?? []).map((v) => v.storage_path);
    if (names.length) {
      const { error } = await sb.rpc("storage_forget_objects", { p_bucket: "projects", p_names: names });
      if (error) throw error;
    }
  }
  return projects.length;
}

if (values.clean) {
  console.log(`Removed placeholder files of ${await deleteStoredFiles()} demo project(s).`);
  runSql(sqlFile("star-gardens-clean.sql"));
  for (const p of await profilesLike("demo\\_sg\\_")) {
    const { error } = await sb.auth.admin.deleteUser(p.id);
    if (error) throw new Error(`Could not delete ${p.username}: ${error.message}`);
  }
  console.log("Star Gardens demo data and demo users removed.");
  process.exit(0);
}

const { data: company, error: companyError } = await sb.from("companies").select("id, name, features")
  .eq("normalized_name", "star gardens").is("archived_at", null).maybeSingle();
if (companyError) throw companyError;
if (!company) throw new Error('No active company named "Star Gardens".');
if (!company.features?.includes("projects")) throw new Error("Switch on the Projects module for Star Gardens first (Super settings → Companies).");
if ((await demoProjects()).length) throw new Error("The demo data is already there. Remove it first: pnpm seed:star-gardens --clean");

const password = values.logins ? `Demo-${randomBytes(9).toString("base64url")}` : null;

async function createLogin(u, extraMeta = {}) {
  const { data, error } = await sb.auth.admin.createUser({
    email: `${u.username}@${domain}`,
    password: password ?? randomBytes(24).toString("base64url"),
    email_confirm: true,
    app_metadata: {
      crm_username: u.username, crm_display_name: u.displayName, crm_role: u.role, crm_company_id: company.id,
      ...(u.extra?.length ? { crm_extra_roles: u.extra } : {}), ...extraMeta,
    },
  });
  if (error) throw new Error(`Could not create ${u.username}: ${error.message}`);
  if (!password || u.inactive) {
    await sb.from("profiles").update({ is_active: false }).eq("id", data.user.id);
    await sb.auth.admin.updateUserById(data.user.id, { ban_duration: "876000h" });
  }
  return data.user.id;
}

const existingProfiles = await profilesLike("demo\\_sg\\_");
const existing = new Set(existingProfiles.map((p) => p.username));
// Users left over from an earlier, failed run: give them this run's password so the one printed below works.
if (password) {
  const active = new Set([...USERS, ...CLIENTS].filter((u) => !u.inactive).map((u) => u.username));
  for (const p of existingProfiles.filter((p) => active.has(p.username))) {
    const { error } = await sb.auth.admin.updateUserById(p.id, { password });
    if (error) throw new Error(`Could not set the password of ${p.username}: ${error.message}`);
  }
}
for (const u of USERS.filter((u) => !existing.has(u.username))) await createLogin(u);
console.log(`Demo users ready in ${company.name}. Adding the data…`);
runSql(sqlFile("star-gardens.sql"));

// ----- placeholder files -----------------------------------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
/** A 640×400 PNG: a green garden-ish gradient with a lighter band. */
function png(seed) {
  const w = 640, h = 400, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3, band = Math.abs(y - h / 2 - 40 * Math.sin((x + seed) / 60)) < 30;
      raw[i] = band ? 200 : 30 + (x * 60) / w; raw[i + 1] = band ? 220 : 90 + (y * 100) / h; raw[i + 2] = band ? 170 : 50;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** A one-page PDF saying what it stands in for. */
function pdf(title) {
  const text = (s) => s.replace(/[^\x20-\x7e]/g, "-").replace(/[()\\]/g, "\\$&");
  const stream = `BT /F1 22 Tf 60 720 Td (${text(title)}) Tj 0 -36 Td /F1 13 Tf (Star Gardens demo placeholder - not a real drawing.) Tj ET`;
  const objs = ["<</Type/Catalog/Pages 2 0 R>>", "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
    `<</Length ${stream.length}>>stream\n${stream}\nendstream`, "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj${o}endobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const projects = await demoProjects();
let uploaded = 0;
for (const p of projects) {
  const { data: versions, error } = await sb.from("project_file_versions").select("storage_path, mime_type, original_name, version_no").eq("project_id", p.id);
  if (error) throw error;
  for (const v of versions) {
    const body = v.mime_type === "application/pdf" ? pdf(`${v.original_name} - v${v.version_no}`)
      : v.mime_type === "image/png" ? png(uploaded * 37)
      : Buffer.from(`Star Gardens demo placeholder for ${v.original_name} (v${v.version_no}).\n`);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `projects/${v.storage_path}`, Body: body, ContentType: v.mime_type }));
    const { error: ledger } = await sb.rpc("storage_record_object", { p_bucket: "projects", p_name: v.storage_path, p_size: body.length, p_mime: v.mime_type });
    if (ledger) throw ledger;
    uploaded++;
  }
}
console.log(`Uploaded ${uploaded} placeholder file(s).`);

// ----- client logins and what they did in the portal ---------------------------
for (const c of CLIENTS) {
  const project = projects.find((p) => p.code === c.project);
  if (!existing.has(c.username)) await createLogin({ ...c, role: "client" }, { crm_project_id: project.id });
}
runSql(sqlFile("star-gardens-portal.sql"));

console.log("\nStar Gardens demo data added. Remove it any time with: pnpm seed:star-gardens --clean");
if (password) {
  console.log(`\nSign in as any of these with the password ${password} (shown once):`);
  for (const u of [...USERS, ...CLIENTS].filter((u) => !u.inactive)) console.log(`  ${u.username.padEnd(22)} ${u.displayName}`);
  console.log("demo_sg_bdm2, demo_sg_ld3 and demo_sg_client_villa are switched off on purpose.");
}
