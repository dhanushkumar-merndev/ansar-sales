// What the Telegram bot says back when a user messages it. Pure functions (no I/O): the webhook
// fetches the user's summary (public.telegram_bot_summary) and sends what these return.
import { ROLE_LABELS, SUPER_ADMIN_LABEL, type DbRole } from "@/lib/constants";

export type BotSummary =
  | { connected: false }
  | {
      connected: true;
      name: string;
      role: DbRole;
      date: string;
      today?: number;
      overdue?: number;
      tasks?: { task: string; lead_name: string; due_at: string; overdue: boolean }[];
      team?: { new_leads: number; won: number; overdue: number };
      finance?: { month: string; expense_total: number | string; expense_count: number; capital_total: number | string };
      ads?: { problem_count: number; problem_names: string[] };
    };
type Connected = Extract<BotSummary, { connected: true }>;

export type BotReply = {
  text: string;
  reply_markup?:
    | { keyboard: { text: string }[][]; resize_keyboard: true; is_persistent: true }
    | { inline_keyboard: { text: string; url: string }[][] };
};

export type BotCommand = "today" | "test" | "help";

const BUTTON = { today: "📋 Today", test: "🧪 Test", help: "❓ Help" } as const;

/** Text of a private-chat message (anything but "/start <token>", which the webhook handles first). */
export function parseIncomingText(update: unknown): { chatId: number; text: string } | null {
  const msg = (update as { message?: { text?: string; chat?: { id?: number; type?: string } } })?.message;
  if (msg?.chat?.type !== "private" || typeof msg.chat.id !== "number") return null;
  return { chatId: msg.chat.id, text: (msg.text ?? "").trim() };
}

/** Commands and the keyboard buttons map to the same actions; anything else gets the help menu. */
export function commandOf(text: string): BotCommand {
  const t = text.trim().toLowerCase().replace(/@\w+$/, "");
  if (t === "/today" || t === BUTTON.today.toLowerCase() || t === "today") return "today";
  if (t === "/test" || t === BUTTON.test.toLowerCase() || t === "test") return "test";
  return "help";
}

/** Roles with a "Today" summary (a client portal login has nothing to summarise). */
const hasToday = (role: DbRole) => role !== "client";
const roleLabel = (role: DbRole) => (role === "super_admin" ? SUPER_ADMIN_LABEL : ROLE_LABELS[role]);

/** Menu for Telegram's "/" button, per role. */
export function botCommandsFor(role: DbRole) {
  return [
    ...(hasToday(role) ? [{ command: "today", description: "Your summary for today" }] : []),
    { command: "test", description: "Check that notifications reach you" },
    { command: "help", description: "What this bot can do" },
  ];
}

// Kept in line with the per-role notification kinds (private.notification_kinds_for).
const ALERTS: Record<DbRole, string> = {
  super_admin: "new leads and results, your follow-ups, finance entries, library files, ads alerts and the evening team report",
  admin: "new leads and results, your follow-ups, finance entries, library files, ads alerts and the evening team report",
  sales: "leads assigned to you, follow-up reminders, overdue alerts, new library files and a morning task list",
  account: "new expenses and capital, monthly expenses and the monthly finance summary",
  ads_manager: "new ads clients and ad accounts that need attention",
  client: "updates from your account team",
};

export function buildHelp(s: Connected, appUrl: string | null): BotReply {
  const keyboard = hasToday(s.role) ? [[{ text: BUTTON.today }, { text: BUTTON.test }], [{ text: BUTTON.help }]] : [[{ text: BUTTON.test }, { text: BUTTON.help }]];
  return {
    text: [
      `Hi ${s.name} (${roleLabel(s.role)}) 👋`,
      `I send your CRM alerts here: ${ALERTS[s.role]}.`,
      "",
      ...(hasToday(s.role) ? [`${BUTTON.today} or /today — ${todayBlurb(s.role)}`] : []),
      `${BUTTON.test} or /test — check that messages reach you`,
      `${BUTTON.help} or /help — show this menu`,
      ...(appUrl ? ["", `Open the CRM: ${appUrl}`] : []),
    ].join("\n"),
    reply_markup: { keyboard, resize_keyboard: true, is_persistent: true },
  };
}

function todayBlurb(role: DbRole) {
  if (role === "account") return "this month's expenses and capital";
  if (role === "ads_manager") return "ad accounts that need attention";
  if (role === "admin" || role === "super_admin") return "your tasks and the team's day";
  return "your tasks due today and overdue";
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const istTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
const istDayMonth = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
const istDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
const monthName = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });

const open = (appUrl: string | null, path: string, label: string): BotReply["reply_markup"] =>
  appUrl ? { inline_keyboard: [[{ text: label, url: `${appUrl.replace(/\/$/, "")}${path}` }]] } : undefined;

/** The role's short, prioritised summary. */
export function buildToday(s: Connected, appUrl: string | null): BotReply {
  const header = `${istDayMonth.format(new Date(`${s.date}T12:00:00+05:30`))}`;
  if (s.role === "account" && s.finance) {
    const f = s.finance;
    return {
      text: [
        `💰 ${monthName.format(new Date(`${f.month}-01T00:00:00Z`))} so far`,
        `Expenses: ${inr.format(Number(f.expense_total))} (${f.expense_count} ${f.expense_count === 1 ? "entry" : "entries"})`,
        `Capital added: ${inr.format(Number(f.capital_total))}`,
      ].join("\n"),
      reply_markup: open(appUrl, "/finance", "Open finance"),
    };
  }
  if (s.role === "ads_manager" && s.ads) {
    const n = s.ads.problem_count;
    return {
      text: n
        ? [`📣 Ad accounts needing attention: ${n}`, ...s.ads.problem_names.map((x) => `• ${x}`), ...(n > s.ads.problem_names.length ? [`…and ${n - s.ads.problem_names.length} more`] : [])].join("\n")
        : "📣 All ad accounts are syncing. Nothing needs attention.",
      reply_markup: open(appUrl, "/ads", "Open ads"),
    };
  }
  if (s.tasks) {
    const tasks = s.tasks;
    const lines = [`📋 Today — ${header} · Due ${s.today ?? 0} · Overdue ${s.overdue ?? 0}`];
    if (!tasks.length) lines.push("No follow-ups due today. 🎉");
    for (const t of tasks) {
      const due = new Date(t.due_at);
      const when = istDate.format(due) === s.date ? istTime.format(due) : `${istDayMonth.format(due)}, ${istTime.format(due)}`;
      lines.push(`• ${t.overdue ? "⚠️ " : ""}${when} — ${t.lead_name}: ${t.task}`);
    }
    const total = (s.today ?? 0) + (s.overdue ?? 0);
    if (total > tasks.length) lines.push(`…and ${total - tasks.length} more`);
    if (s.team) lines.push("", `🏢 Team today: New leads ${s.team.new_leads} · Won ${s.team.won} · Overdue ${s.team.overdue}${s.team.overdue ? " ⚠️" : ""}`);
    const path = (s.overdue ?? 0) > 0 ? "/follow-ups?view=overdue" : "/follow-ups?view=today";
    return { text: lines.join("\n"), reply_markup: open(appUrl, path, "Open follow-ups") };
  }
  return { text: "Nothing to summarise for your account. Use /help to see what I can do." };
}

export function buildTestReply(s: Connected): BotReply {
  return { text: `✅ Test message\nHi ${s.name}, Telegram messages from the CRM reach you.` };
}

export const NOT_CONNECTED_TEXT = "To receive CRM alerts here, open Settings in the CRM and use “Connect Telegram”.";
