import fs from "node:fs";
import path from "node:path";

export type AppRole = "admin" | "sales" | "account";

/** Fixed test accounts. Every E2E user name starts with `e2e_` so teardown can find all of them. */
export const ACCOUNTS = {
  admin: { username: "e2e_admin", displayName: "E2E Admin", role: "admin" },
  salesA: { username: "e2e_sales_a", displayName: "E2E Sales A", role: "sales" },
  salesB: { username: "e2e_sales_b", displayName: "E2E Sales B", role: "sales" },
  account: { username: "e2e_account", displayName: "E2E Account", role: "account" },
} as const satisfies Record<string, { username: string; displayName: string; role: AppRole }>;

export type AccountKey = keyof typeof ACCOUNTS;
export const ACCOUNT_KEYS = Object.keys(ACCOUNTS) as AccountKey[];

export const AUTH_DIR = path.join(__dirname, "..", ".auth");
export const storageState = (key: AccountKey) => path.join(AUTH_DIR, `${key}.json`);
const RUN_FILE = path.join(AUTH_DIR, "run.json");

export type RunInfo = { runId: string; password: string; ids: Record<AccountKey, string> };

export function writeRun(info: RunInfo) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(RUN_FILE, JSON.stringify(info, null, 2), { mode: 0o600 });
}

export function readRun(): RunInfo {
  return JSON.parse(fs.readFileSync(RUN_FILE, "utf8"));
}
