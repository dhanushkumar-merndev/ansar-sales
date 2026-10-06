// What the Telegram bot says back when a connected user messages it: their role's dashboard
// summary, nothing else. Pure functions (no I/O): the webhook fetches the summary
// (public.telegram_bot_summary) and sends what these return.
import type { DbRole } from "@/lib/constants";

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

/**
 * The reply. It always removes the custom keyboard (an earlier version of the bot showed
 * Today / Test / Help buttons), so the CRM link is part of the text rather than a button.
 */
export type BotReply = { text: string; reply_markup: { remove_keyboard: true } };

/** Text of a private-chat message (anything but "/start <token>", which the webhook handles first). */
export function parseIncomingText(update: unknown): { chatId: number; text: string } | null {
  const msg = (update as { message?: { text?: string; chat?: { id?: number; type?: string } } })?.message;
  if (msg?.chat?.type !== "private" || typeof msg.chat.id !== "number") return null;
  return { chatId: msg.chat.id, text: (msg.text ?? "").trim() };
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const istTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
const istDayMonth = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
const istDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
const monthName = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });

const link = (appUrl: string | null, path: string) => (appUrl ? [`🔗 ${appUrl.replace(/\/$/, "")}${path}`] : []);
const reply = (lines: string[]): BotReply => ({ text: lines.join("\n"), reply_markup: { remove_keyboard: true } });

/** The role's short dashboard: whatever is most worth knowing right now. */
export function buildDashboard(s: Connected, appUrl: string | null): BotReply {
  const hi = `👋 Hi ${s.name}`;
  const day = istDayMonth.format(new Date(`${s.date}T12:00:00+05:30`));

  if (s.role === "account" && s.finance) {
    const f = s.finance;
    return reply([
      hi, "",
      `💰 ${monthName.format(new Date(`${f.month}-01T00:00:00Z`))} so far`,
      `Expenses: ${inr.format(Number(f.expense_total))} (${f.expense_count} ${f.expense_count === 1 ? "entry" : "entries"})`,
      `Capital added: ${inr.format(Number(f.capital_total))}`,
      ...link(appUrl, "/finance"),
    ]);
  }

  if (s.role === "ads_manager" && s.ads) {
    const n = s.ads.problem_count;
    return reply([
      hi, "",
      ...(n
        ? [`📣 Ad accounts needing attention: ${n}`, ...s.ads.problem_names.map((x) => `• ${x}`), ...(n > s.ads.problem_names.length ? [`…and ${n - s.ads.problem_names.length} more`] : [])]
        : ["📣 All ad accounts are syncing. Nothing needs attention."]),
      ...link(appUrl, "/ads"),
    ]);
  }

  if (s.tasks) {
    const lines = [hi, "", `📋 ${day} · Due today ${s.today ?? 0} · Overdue ${s.overdue ?? 0}`];
    if (!s.tasks.length) lines.push("No follow-ups due today. 🎉");
    for (const t of s.tasks) {
      const due = new Date(t.due_at);
      const when = istDate.format(due) === s.date ? istTime.format(due) : `${istDayMonth.format(due)}, ${istTime.format(due)}`;
      lines.push(`• ${t.overdue ? "⚠️ " : ""}${when} — ${t.lead_name}: ${t.task}`);
    }
    const total = (s.today ?? 0) + (s.overdue ?? 0);
    if (total > s.tasks.length) lines.push(`…and ${total - s.tasks.length} more`);
    if (s.team) lines.push("", `🏢 Team today: New leads ${s.team.new_leads} · Won ${s.team.won} · Overdue ${s.team.overdue}${s.team.overdue ? " ⚠️" : ""}`);
    return reply([...lines, ...link(appUrl, s.team ? "/dashboard" : "/follow-ups")]);
  }

  return reply([hi, "Your CRM alerts arrive here.", ...link(appUrl, "/")]);
}

export const NOT_CONNECTED_TEXT = "To receive CRM alerts here, open Settings in the CRM and use “Connect Telegram”.";
