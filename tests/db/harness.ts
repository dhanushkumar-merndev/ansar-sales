import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";

const root = join(__dirname, "..", "..");
const migrationsDir = join(root, "supabase", "migrations");

export type Role = "admin" | "sales" | "account";
export type Db = PGlite;
type Queryable = PGlite | Transaction;

export async function createDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec("set timezone = 'UTC'");
  await db.exec(readFileSync(join(__dirname, "supabase-stub.sql"), "utf8"));
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  return db;
}

/** Creates an Auth user the same way the server action does (app_metadata → profile trigger). */
export async function createUser(db: PGlite, username: string, role: Role, displayName = username) {
  const res = await db.query<{ id: string }>(
    `insert into auth.users (email, raw_app_meta_data) values ($1, $2) returning id`,
    [`${username}@login.test`, { crm_username: username, crm_display_name: displayName, crm_role: role }],
  );
  return res.rows[0].id;
}

/** Runs fn inside a transaction as an authenticated user (RLS applies), then rolls back nothing. */
export async function asUser<T>(db: PGlite, userId: string | null, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(userId ? { sub: userId, role: "authenticated" } : { role: "anon" }),
    ]);
    await tx.exec(`set local role ${userId ? "authenticated" : "anon"}`);
    return fn(tx);
  });
}

export async function asService<T>(db: PGlite, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    await tx.exec(`set local role service_role`);
    return fn(tx);
  });
}

export async function one<T = Record<string, unknown>>(q: Queryable, sql: string, params: unknown[] = []) {
  const res = await q.query<T>(sql, params);
  return res.rows[0];
}

export async function rows<T = Record<string, unknown>>(q: Queryable, sql: string, params: unknown[] = []) {
  return (await q.query<T>(sql, params)).rows;
}

let phoneSeq = 9000000000;
export function nextPhone() {
  phoneSeq += 1;
  return `+91${phoneSeq}`;
}

export async function createLead(
  db: PGlite,
  userId: string,
  opts: { name?: string; niche?: string; ownerId?: string; followUpAt?: string; note?: string; phone?: string } = {},
) {
  const phone = opts.phone ?? nextPhone();
  return asUser(db, userId, async (tx) =>
    (
      await one<{ id: string }>(
        tx,
        `select public.create_lead(p_name => $1, p_phone => $2, p_phone_normalized => $2, p_new_niche => $3,
           p_owner_id => $4, p_follow_up_at => $5, p_note => $6) as id`,
        [opts.name ?? "Lead", phone, opts.niche ?? "Retail", opts.ownerId ?? null, opts.followUpAt ?? null, opts.note ?? null],
      )
    ).id,
  );
}
