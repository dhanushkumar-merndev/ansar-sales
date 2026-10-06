import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createUser, one, rows, type Db } from "./harness";

let db: Db;
let admin: string, account: string, sales: string;

beforeAll(async () => {
  db = await createDb();
  admin = await createUser(db, "admin", "admin");
  account = await createUser(db, "account", "account");
  sales = await createUser(db, "sales", "sales");
  await db.query("insert into public.telegram_connections (user_id, chat_id) values ($1, 111), ($2, 222)", [admin, sales]);
});

const addExpense = (date: string, extra = "") =>
  asUser(db, account, async (tx) => (await one<{ id: string }>(tx,
    `insert into public.expenses (expense_date, category, amount, item, payment_mode, created_by${extra ? ", description" : ""})
     values ($1, 'software', 499, 'Canva', 'upi', $2${extra ? ", $3" : ""}) returning id`, extra ? [date, account, extra] : [date, account])).id);
const generate = () => one<{ n: number }>(db, "select private.generate_recurring_expenses() as n");
const series = (id: string) => rows<{ expense_date: string; amount: string; item: string }>(db,
  "select to_char(expense_date, 'YYYY-MM-DD') as expense_date, amount::text, item from public.expenses where recurrence_id = $1 order by expense_date", [id]);

describe("recurring expenses", () => {
  it("next_month_on_day keeps the day and clamps to the month's end", async () => {
    const r = await rows<{ d: string }>(db, `select to_char(private.next_month_on_day(d::date, day), 'YYYY-MM-DD') as d
      from (values ('2025-01-31', 31), ('2024-01-31', 31), ('2025-02-28', 31), ('2025-12-15', 15)) v(d, day)`);
    expect(r.map((x) => x.d)).toEqual(["2025-02-28", "2024-02-29", "2025-03-31", "2026-01-15"]);
  });

  it("adds each missed month once, on the same day, and notifies connected finance users only", async () => {
    const start = (await one<{ d: string }>(db, "select to_char(private.ist_today() - interval '75 days', 'YYYY-MM-DD') as d")).d;
    const e = await addExpense(start);
    const rid = await asUser(db, account, async (tx) => (await one<{ id: string }>(tx, "select public.set_expense_recurrence($1, true) as id", [e])).id);
    expect((await series(rid)).length).toBe(1);

    const added = (await generate()).n;
    expect(added).toBeGreaterThanOrEqual(2);
    const after = await series(rid);
    expect(after.length).toBe(1 + added);
    expect(new Set(after.map((x) => x.amount + x.item))).toEqual(new Set(["499.00Canva"]));
    expect((await generate()).n).toBe(0); // idempotent

    const notes = await rows<{ recipient_id: string; payload: { item: string; amount: number } }>(db,
      "select recipient_id, payload from public.telegram_notifications where kind = 'recurring_expense'");
    expect(notes.length).toBe(added); // admin only: account has no Telegram, sales is not a finance user
    expect(notes.every((n) => n.recipient_id === admin && n.payload.item === "Canva")).toBe(true);

    const next = await one<{ n: string; t: string }>(db, "select next_date::text as n, private.ist_today()::text as t from public.expense_recurrences where id = $1", [rid]);
    expect(next.n > next.t).toBe(true);
  });

  it("stopping the series halts generation; only finance users can change it", async () => {
    const start = (await one<{ d: string }>(db, "select to_char(private.ist_today() - interval '40 days', 'YYYY-MM-DD') as d")).d;
    const e = await addExpense(start, "stop me");
    await expect(asUser(db, sales, (tx) => tx.query("select public.set_expense_recurrence($1, true)", [e]))).rejects.toThrow(/forbidden/);
    const rid = await asUser(db, account, async (tx) => (await one<{ id: string }>(tx, "select public.set_expense_recurrence($1, true) as id", [e])).id);
    await asUser(db, admin, (tx) => tx.query("select public.set_expense_recurrence($1, false)", [e]));
    await generate();
    expect((await series(rid)).length).toBe(1);
    await expect(asUser(db, sales, (tx) => rows(tx, "select * from public.expense_recurrences"))).resolves.toEqual([]);
    await expect(asUser(db, account, (tx) => rows(tx, "select * from public.telegram_notifications"))).resolves.toEqual([]);
  });

  it("the notification queue is claimed once and finished by the service role", async () => {
    const claimed = await asService(db, (tx) => rows<{ notification_id: string; lease_token: string; chat_id: string }>(tx, "select * from public.claim_due_notifications(10, 60)"));
    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed.every((c) => String(c.chat_id) === "111")).toBe(true);
    expect(await asService(db, (tx) => rows(tx, "select * from public.claim_due_notifications(10, 60)"))).toEqual([]);
    const done = await asService(db, async (tx) => (await one<{ r: string }>(tx, "select public.finish_notification($1, $2, 'sent') as r", [claimed[0].notification_id, claimed[0].lease_token])).r);
    expect(done).toBe("sent");
    await expect(asUser(db, admin, (tx) => tx.query("select * from public.claim_due_notifications(10, 60)"))).rejects.toThrow(/permission denied/);
  });
});
