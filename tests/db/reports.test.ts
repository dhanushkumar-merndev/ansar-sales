import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createLead, createUser, one, rows, type Db } from "./harness";

let db: Db;
let admin: string, salesA: string, salesB: string, account: string;
let today: string;

type LeadReport = {
  range: { from: string; to: string; bucket: string }; scope: string;
  cards: Record<string, number | null>; trend: { period: string; created: number; won: number; lost: number }[];
  funnel: { status: string; count: number }[]; niches: { name: string; created: number; won: number }[];
  follow_up_outcomes: Record<string, number>; salespeople: { name: string; created: number; won: number }[] | null;
};
type FinanceReport = {
  range: { bucket: string; months: number }; cards: Record<string, number | null>;
  trend: { period: string; capital: number; expense: number }[];
  items: { kind: string; item: string; quantity: number; total: number; entries: number }[];
  payment_modes: { mode: string; capital: number; expense: number }[];
  contributors: { name: string; total: number }[]; categories: { category: string; total: number }[];
};

const leadReport = (user: string, from: string, to: string) =>
  asUser(db, user, async (tx) => (await one<{ r: LeadReport }>(tx, "select public.report_leads($1, $2) as r", [from, to])).r);
const financeReport = (user: string, from: string, to: string) =>
  asUser(db, user, async (tx) => (await one<{ r: FinanceReport }>(tx, "select public.report_finance($1, $2) as r", [from, to])).r);

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin", "Admin");
  salesA = await createUser(db, "sales.a", "sales", "Sales A");
  salesB = await createUser(db, "sales.b", "sales", "Sales B");
  account = await createUser(db, "account", "account");
  today = (await one<{ d: string }>(db, "select to_char(private.ist_today(), 'YYYY-MM-DD') as d")).d;
});

describe("reports", () => {
  it("lead report: admin sees the team, sales only their own leads; wins, funnel and niches are counted", async () => {
    const a1 = await createLead(db, salesA, { niche: "Retail" });
    const a2 = await createLead(db, salesA, { niche: "Retail" });
    await createLead(db, salesB, { niche: "Education" });
    for (const s of ["contacted", "proposal_sent", "won"]) await asUser(db, salesA, (tx) => tx.query("update public.leads set status = $2 where id = $1", [a1, s]));
    await asUser(db, salesA, (tx) => tx.query("update public.leads set status = 'lost' where id = $1", [a2]));

    const team = await leadReport(admin, today, today);
    expect(team.scope).toBe("team");
    expect(team.range.bucket).toBe("day");
    expect(team.cards.created).toBe(3);
    expect(team.cards.won).toBe(1);
    expect(team.cards.lost).toBe(1);
    expect(team.trend).toEqual([{ period: today, created: 3, won: 1, lost: 1 }]);
    expect(team.funnel.map((f) => f.count)).toEqual([3, 1, 1, 1, 1]); // new, contacted, interested (passed through), proposal, won
    expect(team.niches).toEqual([{ name: "Retail", created: 2, won: 1 }, { name: "Education", created: 1, won: 0 }]);
    expect(team.salespeople!.find((p) => p.name === "Sales A")).toMatchObject({ created: 2, won: 1 });

    const mine = await leadReport(salesB, today, today);
    expect(mine.scope).toBe("mine");
    expect(mine.cards.created).toBe(1);
    expect(mine.cards.won).toBe(0);
    expect(mine.salespeople).toBeNull();
    expect(mine.niches).toEqual([{ name: "Education", created: 1, won: 0 }]);
  });

  it("finance report: totals per range, items with quantities, separate from expenses", async () => {
    await asUser(db, account, async (tx) => {
      await tx.query(
        `insert into public.capital_entries (entry_date, contributor, amount, item, quantity, created_by) values
          ('2025-02-03', 'Ansar', 52000, 'Chair', 8, $1), ('2025-02-20', 'ansar ', 13000, ' chair', 2, $1),
          ('2025-03-01', 'Partner', 100000.50, null, null, $1), ('2024-12-31', 'Ansar', 999, 'Desk', 1, $1)`, [account]);
      await tx.query("update public.capital_entries set payment_mode = 'upi' where contributor = 'Partner'");
      await tx.query(
        `insert into public.expenses (expense_date, category, amount, created_by) values
          ('2025-02-10', 'rent', 20000, $1), ('2025-03-05', 'software', 1999.99, $1), ('2025-04-01', 'rent', 1, $1)`, [account]);
      await tx.query(
        `insert into public.expenses (expense_date, category, amount, item, quantity, payment_mode, created_by) values
          ('2025-03-06', 'miscellaneous', 600, 'Chair', 3, 'cash', $1)`, [account]);
    });
    const r = await financeReport(account, "2025-01-01", "2025-03-31");
    expect(r.range).toMatchObject({ bucket: "week", months: 3 });
    expect(Number(r.cards.capital_total)).toBe(165000.5);
    expect(Number(r.cards.capital_before)).toBe(999);
    expect(Number(r.cards.expense_total)).toBe(22599.99);
    expect(r.cards.capital_items_quantity).toBe(10);
    expect(r.cards.expense_items_quantity).toBe(3);
    expect(r.cards.items_distinct).toBe(2); // Chair on capital and Chair on expenses are tracked separately
    expect(r.items).toEqual([
      { kind: "capital", item: "Chair", quantity: 10, total: 65000, entries: 2 },
      { kind: "expense", item: "Chair", quantity: 3, total: 600, entries: 1 },
    ]);
    expect(r.payment_modes.map((m) => [m.mode, Number(m.capital), Number(m.expense)])).toEqual([
      ["upi", 100000.5, 0], ["unspecified", 65000, 21999.99], ["cash", 0, 600],
    ]);
    expect(r.contributors.map((c) => [c.name.trim(), Number(c.total)])).toEqual([["Partner", 100000.5], ["Ansar", 65000]]);
    expect(r.trend.reduce((s, p) => s + Math.round(Number(p.capital) * 100), 0)).toBe(16500050);
    expect(r.trend.reduce((s, p) => s + Math.round(Number(p.expense) * 100), 0)).toBe(2259999);

    const year = await financeReport(account, "2024-01-01", "2025-12-31");
    expect(year.range.bucket).toBe("month");
    expect(year.trend).toHaveLength(24);
  });

  it("item edits are audited; quantity requires an item; payment mode is allowlisted", async () => {
    const id = await asUser(db, account, async (tx) => (await one<{ id: string }>(tx,
      "insert into public.capital_entries (entry_date, contributor, amount, item, quantity, created_by) values ('2025-05-01', 'A', 10, 'Table', 1, $1) returning id", [account])).id);
    await asUser(db, account, (tx) => tx.query("update public.capital_entries set quantity = 4 where id = $1", [id]));
    const h = await asUser(db, account, (tx) => rows<{ changes: Record<string, unknown> }>(tx,
      "select changes from public.finance_activities where entity_id = $1 and action = 'updated'", [id]));
    expect(h[0].changes).toEqual({ quantity: { from: 1, to: 4 } });
    await expect(asUser(db, account, (tx) => tx.query(
      "insert into public.capital_entries (entry_date, contributor, amount, quantity, created_by) values ('2025-05-01', 'A', 10, 3, $1)", [account]))).rejects.toThrow(/quantity_needs_item/);
    await expect(asUser(db, account, (tx) => tx.query(
      "insert into public.expenses (expense_date, category, amount, payment_mode, created_by) values ('2025-05-01', 'rent', 10, 'barter', $1)", [account]))).rejects.toThrow(/payment_mode/);
  });

  it("enforces roles and range bounds", async () => {
    await expect(financeReport(salesA, today, today)).rejects.toThrow(/forbidden/);
    await expect(leadReport(account, today, today)).rejects.toThrow(/forbidden/);
    await expect(leadReport(admin, "2025-02-01", "2025-01-01")).rejects.toThrow(/invalid_report_range/);
    await expect(financeReport(account, "2020-01-01", "2025-01-01")).rejects.toThrow(/invalid_report_range/);
  });
});
