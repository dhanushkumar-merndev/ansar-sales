import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createUser, one, type Db } from "./harness";

let db: Db;
let admin: string, account: string, sales: string;

type Page<T> = { items: T[]; total: number };
type Exp = { id: string; expense_date: string; amount: number; item: string | null; recurrence: { active: boolean } | null; author: { display_name: string } };

const call = <T>(user: string | null, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await one<{ r: T }>(tx, sql, params)).r);
const entries = (args: Record<string, unknown>) => {
  const keys = Object.keys(args);
  return call<Page<Exp>>(account, `select public.list_finance_entries(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, Object.values(args));
};

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  account = await createUser(db, "account", "account", "Accounts");
  sales = await createUser(db, "sales", "sales");
  await asUser(db, account, async (tx) => {
    await tx.query(
      `insert into public.expenses (expense_date, category, amount, payment_mode, item, quantity, description, created_by) values
        ('2025-03-03', 'rent', 25000, 'bank_transfer', null, null, 'March rent', $1),            -- Monday
        ('2025-03-08', 'software', 499, 'card', 'Canva', 3, 'seats', $1),                        -- Saturday
        ('2025-03-08', 'software', 1999, 'card', 'ChatGPT Plus', 1, null, $1),
        ('2025-03-20', 'miscellaneous', 120.50, 'cash', '100% Tea_bags', 2, 'pantry', $1),
        ('2025-03-31', 'salary', 60000, null, 'Staff salary', 2, null, $1),
        ('2025-02-10', 'rent', 25000, 'bank_transfer', null, null, 'Feb rent', $1),
        ('2024-03-15', 'rent', 20000, 'bank_transfer', null, null, 'last year', $1),
        ('2024-12-20', 'utilities', 900, 'upi', null, null, 'December bill', $1)`, [account]);
    await tx.query(
      `insert into public.capital_entries (entry_date, contributor, amount, payment_mode, item, quantity, created_by) values
        ('2025-03-05', 'Ansar', 100000, 'upi', 'Chair', 8, $1), ('2025-01-02', 'Partner', 5000, 'cash', null, null, $1)`, [account]);
  });
  // A monthly series on the Canva entry, and one archived expense in March.
  const canva = (await one<{ id: string }>(db, "select id from public.expenses where item = 'Canva'")).id;
  await asUser(db, account, (tx) => tx.query("select public.set_expense_recurrence($1, true)", [canva]));
  await asUser(db, account, async (tx) => {
    await tx.query("insert into public.expenses (expense_date, category, amount, description, created_by) values ('2025-03-10', 'marketing', 7777, 'archived ad', $1)", [account]);
    await tx.query("update public.expenses set archived_at = now() where description = 'archived ad'");
  });
});

describe("finance period pages", () => {
  it("year overview: months newest first with totals and category split, December carry-over and the year list", async () => {
    const y = await call<{
      months: { month: string; expense: number; expense_entries: number; capital: number; categories: Record<string, number> }[];
      totals: Record<string, number>; previous_december: Record<string, number>; years: number[];
    }>(account, "select public.finance_year_overview(2025) as r");
    expect(y.months).toHaveLength(12);
    expect(y.months[0].month).toBe("2025-12");
    const march = y.months.find((m) => m.month === "2025-03")!;
    expect(Number(march.expense)).toBe(87618.5);
    expect(march.expense_entries).toBe(5);
    expect(Number(march.capital)).toBe(100000);
    expect(Object.fromEntries(Object.entries(march.categories).map(([k, v]) => [k, Number(v)]))).toEqual({ rent: 25000, software: 2498, miscellaneous: 120.5, salary: 60000 });
    expect(Number(y.totals.expense)).toBe(112618.5);
    expect(Number(y.previous_december.expense)).toBe(900);
    expect(y.years.slice(-2)).toEqual([2025, 2024]);
  });

  it("period report: comparisons, recurring split, weekday, size bands, author, archived count", async () => {
    const r = await call<Record<string, unknown> & {
      period: { is_month: boolean; series_bucket: string }; series: { period: string; expense: number; expense_cumulative: number }[];
      previous: { from: string; to: string; expense: number }; last_year: { expense: number }; avg_prior_6: number;
      recurring_split: Record<string, number>; weekday: { dow: number; total: number }[]; size_buckets: { bucket: string; entries: number }[];
      recorded_by: { name: string; entries: number }[]; archived: { expense: number }; cards: Record<string, number>;
    }>(account, "select public.finance_period_report('2025-03-01', '2025-03-31') as r");
    expect(r.period).toMatchObject({ is_month: true, series_bucket: "day" });
    expect(r.series).toHaveLength(31);
    expect(Number(r.series.at(-1)!.expense_cumulative)).toBe(87618.5);
    expect(r.previous).toMatchObject({ from: "2025-02-01", to: "2025-02-28" });
    expect(Number(r.previous.expense)).toBe(25000);
    expect(Number(r.last_year.expense)).toBe(20000);
    expect(Number(r.avg_prior_6)).toBe(round2((25000 + 900) / 6));
    expect(Number(r.recurring_split.monthly)).toBe(499);
    expect(r.recurring_split.one_off_entries).toBe(4);
    expect(Number(r.weekday[0].total)).toBe(25000 + 60000); // 3 Mar and 31 Mar 2025 are Mondays
    expect(Number(r.weekday[5].total)).toBe(2498);           // Saturday
    expect(r.size_buckets.map((b) => b.entries)).toEqual([2, 1, 0, 1, 1]);
    expect(r.recorded_by).toEqual([{ name: "Accounts", entries: 6, total: 187618.5 }]);
    expect(r.archived.expense).toBe(1);
    expect(Number(r.cards.expense_total)).toBe(87618.5); // report_finance sections are included

    const year = await call<{ period: { is_month: boolean; series_bucket: string }; series: unknown[]; avg_prior_6: null; previous: { from: string } }>(
      account, "select public.finance_period_report('2025-01-01', '2025-12-31') as r");
    expect(year.period).toMatchObject({ is_month: false, series_bucket: "month" });
    expect(year.series).toHaveLength(12);
    expect(year.avg_prior_6).toBeNull();
    expect(year.previous.from).toBe("2024-01-01");
  });

  it("entry list: escaped search, filters, both sorts, paging with exact totals, archived view", async () => {
    const base = { p_kind: "expense", p_from: "2025-03-01", p_to: "2025-03-31" };
    const all = await entries(base);
    expect(all.total).toBe(5);
    expect(all.items.map((e) => e.expense_date)).toEqual(["2025-03-31", "2025-03-20", "2025-03-08", "2025-03-08", "2025-03-03"]);
    expect(all.items[0].author.display_name).toBe("Accounts");

    expect((await entries({ ...base, p_search: "100%" })).items.map((e) => e.item)).toEqual(["100% Tea_bags"]);
    expect((await entries({ ...base, p_search: "%" })).total).toBe(1); // % is literal, not a wildcard
    expect((await entries({ ...base, p_search: "_" })).total).toBe(1);
    expect((await entries({ ...base, p_search: "  RENT " })).total).toBe(1); // description, case-insensitive

    expect((await entries({ ...base, p_category: "software" })).total).toBe(2);
    expect((await entries({ ...base, p_mode: "card" })).total).toBe(2);
    expect((await entries({ ...base, p_mode: "unspecified" })).items.map((e) => e.item)).toEqual(["Staff salary"]);
    const monthly = await entries({ ...base, p_recurring: true });
    expect(monthly.items.map((e) => [e.item, e.recurrence?.active])).toEqual([["Canva", true]]);

    expect((await entries({ ...base, p_sort: "amount", p_dir: "desc" })).items.map((e) => Number(e.amount))).toEqual([60000, 25000, 1999, 499, 120.5]);
    expect((await entries({ ...base, p_sort: "amount", p_dir: "asc" })).items.map((e) => Number(e.amount))).toEqual([120.5, 499, 1999, 25000, 60000]);

    const p1 = await entries({ ...base, p_limit: 2, p_offset: 0 });
    const p3 = await entries({ ...base, p_limit: 2, p_offset: 4 });
    expect([p1.total, p1.items.length, p3.items.length]).toEqual([5, 2, 1]);
    const ids = new Set([...p1.items, ...(await entries({ ...base, p_limit: 2, p_offset: 2 })).items, ...p3.items].map((e) => e.id));
    expect(ids.size).toBe(5); // stable order: no row on two pages

    expect((await entries({ ...base, p_archived: true })).items.map((e) => e.amount)).toEqual([7777]);
    const cap = await call<Page<{ contributor: string }>>(account,
      "select public.list_finance_entries('capital', '2025-01-01', '2025-12-31', p_search => 'ansar') as r");
    expect(cap.items.map((c) => c.contributor)).toEqual(["Ansar"]);
  });

  it("rejects bad input and other roles", async () => {
    await expect(call(account, "select public.list_finance_entries('expense', '2025-03-01', '2025-03-31', p_sort => 'id; drop table x') as r")).rejects.toThrow(/invalid_period_query/);
    await expect(call(account, "select public.list_finance_entries('expense', '2025-03-01', '2025-03-31', p_limit => 101) as r")).rejects.toThrow(/invalid_page/);
    await expect(call(account, "select public.list_finance_entries('capital', '2025-03-01', '2025-03-31', p_category => 'rent') as r")).rejects.toThrow(/invalid_period_query/);
    await expect(call(account, "select public.list_finance_entries('expense', '2025-03-01', '2025-03-31', p_search => $1) as r", ["x".repeat(101)])).rejects.toThrow(/search_too_long/);
    await expect(call(account, "select public.finance_year_overview(99999) as r")).rejects.toThrow(/invalid_period_query/);
    await expect(call(account, "select public.finance_period_report('2025-03-31', '2025-03-01') as r")).rejects.toThrow(/invalid_report_range/);
    for (const sql of ["select public.finance_year_overview(2025) as r", "select public.finance_period_report('2025-03-01', '2025-03-31') as r",
      "select public.list_finance_entries('expense', '2025-03-01', '2025-03-31') as r"]) {
      await expect(call(sales, sql)).rejects.toThrow(/forbidden/);
      await expect(call(null, sql)).rejects.toThrow(/permission denied|forbidden/);
    }
    await expect(call(admin, "select public.finance_year_overview(2025) as r")).resolves.toBeTruthy();
  });
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
