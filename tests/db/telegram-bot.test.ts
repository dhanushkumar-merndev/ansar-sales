import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createLead, createUser, one, type Db } from "./harness";

type Summary = {
  connected: boolean; name?: string; role?: string;
  today?: number; overdue?: number; tasks?: { task: string; lead_name: string; overdue: boolean }[];
  team?: { new_leads: number; won: number; overdue: number };
  finance?: { expense_total: number | string; expense_count: number; capital_total: number | string };
};

let db: Db;
let admin: string, salesA: string, salesB: string, account: string;
const CHAT = { admin: 9001, salesA: 9002, salesB: 9003, account: 9004 };

const summary = (chatId: number) =>
  asService(db, async (tx) => (await one<{ r: Summary }>(tx, "select public.telegram_bot_summary($1) as r", [chatId])).r);

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
  account = await createUser(db, "account", "account", "Account");
  await db.query("insert into public.telegram_connections (user_id, chat_id) values ($1, $2), ($3, $4), ($5, $6), ($7, $8)",
    [admin, CHAT.admin, salesA, CHAT.salesA, salesB, CHAT.salesB, account, CHAT.account]);
  const lead = await createLead(db, salesA, { name: "Bot lead" });
  await asUser(db, salesA, (tx) => tx.query(
    "insert into public.follow_ups (lead_id, task, due_at, created_by) values ($1, 'Late call', now() - interval '1 hour', $2), ($1, 'Later', now() + interval '3 days', $2)",
    [lead, salesA]));
  await asUser(db, account, (tx) => tx.query(
    "insert into public.expenses (expense_date, category, amount, created_by) values ((now() at time zone 'Asia/Kolkata')::date, 'rent', 25000, $1)", [account]));
});

describe("telegram_bot_summary", () => {
  it("shows a salesperson only their own follow-ups", async () => {
    const a = await summary(CHAT.salesA);
    expect(a).toMatchObject({ connected: true, name: "Sales A", role: "sales", overdue: 1 });
    expect(a.tasks?.map((t) => t.task)).toEqual(["Late call"]); // due later than today is not listed
    expect(a.tasks?.[0]).toMatchObject({ lead_name: "Bot lead", overdue: true });
    expect(a.team).toBeUndefined();
    const b = await summary(CHAT.salesB);
    expect(b).toMatchObject({ connected: true, today: 0, overdue: 0, tasks: [] });
  });

  it("adds the team's day for admins and this month's totals for accounts", async () => {
    const ad = await summary(CHAT.admin);
    expect(ad.team).toMatchObject({ new_leads: 1, won: 0, overdue: 1 });
    const acc = await summary(CHAT.account);
    expect(acc.tasks).toBeUndefined();
    expect(Number(acc.finance?.expense_total)).toBe(25000);
    expect(acc.finance?.expense_count).toBe(1);
  });

  it("knows nothing about unknown, disconnected or deactivated chats", async () => {
    expect(await summary(123456)).toEqual({ connected: false });
    await db.query("update public.telegram_connections set status = 'blocked' where user_id = $1", [salesB]);
    expect(await summary(CHAT.salesB)).toEqual({ connected: false });
    await db.query("update public.profiles set is_active = false where id = $1", [account]);
    expect(await summary(CHAT.account)).toEqual({ connected: false });
  });

  it("is not callable by signed-in users", async () => {
    await expect(asUser(db, admin, (tx) => tx.query("select public.telegram_bot_summary($1)", [CHAT.admin]))).rejects.toThrow(/permission denied/);
  });
});
