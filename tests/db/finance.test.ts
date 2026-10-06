import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createUser, one, rows, type Db } from "./harness";

let db: Db;
let account: string, admin: string;

type Summary = {
  total_capital: number; current_month_expenses: number; current_month: string;
  monthly: { month: string; total: number }[]; categories: { category: string; total: number }[];
};

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin");
  account = await createUser(db, "account", "account");
});

describe("finance", () => {
  it("keeps capital and expense totals separate, exact and grouped by month", async () => {
    const today = (await one<{ d: string }>(db, "select to_char(private.ist_today(), 'YYYY-MM-DD') as d")).d;
    const monthStart = `${today.slice(0, 8)}01`;
    const prevMonth = (await one<{ d: string }>(db, "select to_char((date_trunc('month', private.ist_today()) - interval '1 day')::date, 'YYYY-MM-DD') as d")).d;
    await asUser(db, account, async (tx) => {
      await tx.query("insert into public.capital_entries (entry_date, contributor, amount, created_by) values ($1, 'Founder', 500000.10, $2)", [monthStart, account]);
      await tx.query("insert into public.expenses (expense_date, category, amount, created_by) values ($1, 'rent', 0.10, $2), ($1, 'rent', 0.20, $2), ($1, 'software', 1999.99, $2)", [monthStart, account]);
      await tx.query("insert into public.expenses (expense_date, category, amount, created_by) values ($1, 'salary', 30000, $2)", [prevMonth, account]);
    });
    const s = await asUser(db, account, async (tx) => (await one<{ r: Summary }>(tx, "select public.dashboard_finance(12) as r")).r);
    expect(Number(s.total_capital)).toBe(500000.1);
    expect(String(s.current_month_expenses)).toBe("2000.29");
    expect(s.monthly).toHaveLength(12);
    expect(s.monthly.at(-1)).toEqual({ month: monthStart, total: 2000.29 });
    expect(Number(s.monthly.at(-2)!.total)).toBe(30000);
    expect(s.categories.map((c) => c.category)).toEqual(["Salary", "Software", "Rent"]);
  });

  it("excludes archived entries and records history for edits and archive", async () => {
    const e = await asUser(db, account, async (tx) => (await one<{ id: string }>(tx,
      "insert into public.expenses (expense_date, category, amount, created_by) values (private.ist_today(), 'marketing', 100, $1) returning id", [account])).id);
    await asUser(db, admin, (tx) => tx.query("update public.expenses set amount = 150 where id = $1", [e]));
    await asUser(db, account, (tx) => tx.query("update public.expenses set archived_at = now() where id = $1", [e]));
    const hist = await asUser(db, account, (tx) => rows<{ action: string; changes: Record<string, unknown> }>(tx,
      "select action, changes from public.finance_activities where entity_id = $1 order by created_at, action", [e]));
    expect(hist.map((h) => h.action).sort()).toEqual(["archived", "created", "updated"]);
    expect(hist.find((h) => h.action === "updated")!.changes).toEqual({ amount: { from: 100, to: 150 } });
    const s = await asUser(db, account, async (tx) => (await one<{ r: Summary }>(tx, "select public.dashboard_finance(12) as r")).r);
    expect(String(s.current_month_expenses)).toBe("2000.29");
  });

  it("rejects non-positive amounts", async () => {
    await expect(asUser(db, account, (tx) => tx.query("insert into public.expenses (expense_date, category, amount, created_by) values (now(), 'rent', 0, $1)", [account]))).rejects.toThrow(/check/);
  });
});
