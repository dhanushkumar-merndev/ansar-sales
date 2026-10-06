// Pure helpers for the reminder worker (no Deno/Node APIs) so they can be unit tested.

export type ClaimedReminder = {
  delivery_id: string;
  lease_token: string;
  chat_id: number;
  lead_id: string;
  lead_name: string;
  lead_phone: string | null;
  task: string;
  due_at: string;
  attempts: number;
};

export type DeliveryOutcome =
  | { result: "sent"; messageId: number | null }
  | { result: "retry"; error: string; retryAfterSeconds: number | null; rateLimited: boolean }
  | { result: "failed"; error: string }
  | { result: "blocked"; error: string };

/** One Telegram inline keyboard button: opens a URL or sends callback data back to the webhook. */
export type InlineButton = { text: string; url: string } | { text: string; callback_data: string };
export type TelegramMessage = { text: string; buttons: InlineButton[][] };

/** Telegram's sendMessage `reply_markup`, or undefined when there are no buttons. */
export function replyMarkup(m: TelegramMessage) {
  return m.buttons.length ? { inline_keyboard: m.buttons } : undefined;
}

const istFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
});
const istTime = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });
const dayFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });

const CATEGORY: Record<string, string> = { salary: "Salary", rent: "Rent", software: "Software", marketing: "Marketing", utilities: "Utilities", miscellaneous: "Miscellaneous" };
const PAYMENT: Record<string, string> = { cash: "Cash", upi: "UPI", bank_transfer: "Bank transfer", cheque: "Cheque", card: "Card", other: "Other" };

// Silence button callback data; parsed by parseCallbackQuery in src/lib/telegram.ts.
const SILENCE_PREFIX = "s:";

/**
 * Adds the "Open in CRM" link. Telegram only accepts https URL buttons, so other URLs
 * (e.g. local development) stay in the text instead.
 */
function finish(lines: string[], appUrl: string | null, path: string, extra: InlineButton[] = [], label = "Open in CRM"): TelegramMessage {
  const url = appUrl ? `${appUrl.replace(/\/+$/, "")}${path}` : null;
  const row: InlineButton[] = [];
  if (url && url.startsWith("https://")) row.push({ text: `🔗 ${label}`, url });
  else if (url) lines.push(`Open: ${url}`);
  row.push(...extra);
  return { text: lines.join("\n").slice(0, 4000), buttons: row.length ? [row] : [] };
}

const due = (iso: string) => `${istFmt.format(new Date(iso))} IST`;
const day = (date: string) => dayFmt.format(new Date(`${date}T00:00:00Z`));

/** "5 min", "2 h 10 min", "3 days" */
export function formatAgo(fromIso: string, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - new Date(fromIso).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}`;
  const days = Math.floor(mins / (24 * 60));
  return `${days} day${days === 1 ? "" : "s"}`;
}

export function buildReminderMessage(r: ClaimedReminder, appUrl: string | null): TelegramMessage {
  const lines = [
    "⏰ Follow-up due",
    `Lead: ${r.lead_name}`,
    `Task: ${r.task}`,
    `Due: ${due(r.due_at)}`,
  ];
  // The recipient is always the lead's current owner (checked at claim time), so the phone is permitted.
  if (r.lead_phone) lines.push(`Phone: ${r.lead_phone}`);
  return finish(lines, appUrl, `/leads/${r.lead_id}`, [], "Open lead");
}

export type NotificationKind =
  | "recurring_expense" | "lead_created" | "lead_assigned" | "lead_closed" | "follow_up_changed" | "overdue_nag"
  | "expense_added" | "capital_added" | "library_file_added" | "digest_sales" | "digest_admin" | "digest_finance" | "test"
  | "ads_client_new" | "ad_account_problem";

export type ClaimedNotification = {
  notification_id: string;
  lease_token: string;
  chat_id: number;
  kind: NotificationKind;
  /** Display data written by the database for this kind (see the enqueue functions in SQL). */
  payload: Record<string, unknown>;
  attempts: number;
};

type Task = { id: string; task: string; due_at: string; lead_name: string; overdue: boolean };
type TeamRow = {
  name: string; active: number; new_today: number; done_today: number; overdue: number; won_today: number;
  actions_today: number; last_activity: string | null;
};

const s = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

function moneyLines(p: Record<string, unknown>) {
  return [
    ...(s(p.item) ? [`Item: ${p.item}${p.quantity ? ` × ${p.quantity} nos` : ""}`] : []),
    `Amount: ${inr.format(Number(p.amount))}`,
    `Date: ${day(String(p.date))}`,
    ...(s(p.payment_mode) ? [`Paid by: ${PAYMENT[String(p.payment_mode)] ?? p.payment_mode}`] : []),
    ...(s(p.description) ? [`Note: ${p.description}`] : []),
  ];
}

/** Text and buttons for one queued notification. `now` is only used for "overdue by". */
export function buildNotification(n: ClaimedNotification, appUrl: string | null, now = new Date()): TelegramMessage {
  const p = n.payload;
  const leadPath = `/leads/${s(p.lead_id) ?? ""}`;
  // The super admin gets every company's alerts: name the company, and open the link in it.
  const company = s(p.company);
  const companyId = s(p.company_id);
  const fin = (lines: string[], path: string, extra: InlineButton[] = [], label?: string) => finish(
    company ? [lines[0], `🏢 ${company}`, ...lines.slice(1)] : lines,
    appUrl,
    companyId ? `/switch?company=${companyId}&next=${encodeURIComponent(path)}` : path,
    extra,
    label,
  );
  switch (n.kind) {
    case "recurring_expense":
      return fin(["🔁 Monthly expense added", `Category: ${CATEGORY[String(p.category)] ?? p.category}`, ...moneyLines(p)], "/finance");
    case "expense_added":
      return fin(["💸 Expense added", `Category: ${CATEGORY[String(p.category)] ?? p.category}`, ...moneyLines(p), `Added by: ${p.actor}`], "/finance");
    case "capital_added":
      return fin(["💰 Capital added", `From: ${p.contributor}`, ...moneyLines(p), `Added by: ${p.actor}`], "/finance");
    case "lead_created":
      return fin(["🆕 New lead", `Lead: ${p.lead_name}`, `Niche: ${p.niche}`, `Owner: ${p.owner}`, `Added by: ${p.actor}`], leadPath, [], "Open lead");
    case "lead_assigned":
      return fin([
        "👤 Lead assigned to you", `Lead: ${p.lead_name}`, ...(s(p.phone) ? [`Phone: ${p.phone}`] : []), `Niche: ${p.niche}`,
        ...(s(p.from) ? [`Previously: ${p.from}`] : []), `Assigned by: ${p.actor}`,
      ], leadPath, [], "Open lead");
    case "lead_closed":
      return fin([p.status === "won" ? "🏆 Lead won" : "❌ Lead lost", `Lead: ${p.lead_name}`, `Owner: ${p.owner}`, `Marked by: ${p.actor}`],
        leadPath, [], "Open lead");
    case "follow_up_changed":
      return fin([
        p.rescheduled ? "📅 Follow-up rescheduled for you" : "📅 Follow-up scheduled for you",
        `Lead: ${p.lead_name}`, `Task: ${p.task}`, `Due: ${due(String(p.due_at))}`, `By: ${p.actor}`,
      ], leadPath, [], "Open lead");
    case "overdue_nag":
      return fin([
        "⚠️ Follow-up overdue", `Lead: ${p.lead_name}`, `Task: ${p.task}`,
        `Was due: ${due(String(p.due_at))} (${formatAgo(String(p.due_at), now)} ago)`,
        ...(s(p.phone) ? [`Phone: ${p.phone}`] : []),
        "Repeats every 5 min until you complete or reschedule it.",
      ], leadPath, [{ text: "🔕 Silence", callback_data: `${SILENCE_PREFIX}${p.follow_up_id}` }], "Open lead");
    case "library_file_added":
      return fin(["📁 New library file", `File: ${p.name}`, `Folder: ${p.folder}`, `Uploaded by: ${p.actor}`],
        `/library/${s(p.folder_id) ?? ""}`, [], "Open folder");
    case "digest_sales": {
      const tasks = (p.tasks as Task[] | undefined) ?? [];
      const total = Number(p.today) + Number(p.overdue);
      const lines = [
        `📋 Your tasks — ${day(String(p.date))}`, `Due today: ${p.today} · Overdue: ${p.overdue}`, "",
        ...tasks.map((t) => `• ${t.overdue ? "⚠️ " : ""}${istTime.format(new Date(t.due_at))} — ${t.lead_name}: ${t.task}`),
        ...(total > tasks.length ? [`…and ${total - tasks.length} more`] : []),
      ];
      return fin(lines, `/follow-ups?view=${Number(p.overdue) > 0 ? "overdue" : "today"}`, [], "Open follow-ups");
    }
    case "digest_admin": {
      const rows = (p.rows as TeamRow[] | undefined) ?? [];
      const lines = [`📊 Team report — ${day(String(p.date))}`, ""];
      if (!rows.length) lines.push("No active sales users.");
      for (const r of rows) {
        lines.push(
          `👤 ${r.name}`,
          `   Active ${r.active} · New ${r.new_today} · Done ${r.done_today} · Overdue ${r.overdue}${Number(r.overdue) > 0 ? " ⚠️" : ""} · Won ${r.won_today}`,
          `   ${r.actions_today} actions today · Last active ${r.last_activity ? due(r.last_activity) : "never"}`,
        );
      }
      return fin(lines, "/dashboard", [], "Open dashboard");
    }
    case "digest_finance": {
      const cats = (p.categories as { category: string; total: number | string }[] | undefined) ?? [];
      const lines = [
        `📈 Finance summary — ${monthFmt.format(new Date(`${p.month}-01T00:00:00Z`))}`,
        `Expenses: ${inr.format(Number(p.expense_total))} (${p.expense_count} entries)`,
        ...cats.map((c) => `   • ${CATEGORY[c.category] ?? c.category}: ${inr.format(Number(c.total))}`),
        `Capital added: ${inr.format(Number(p.capital_total))}`,
      ];
      return fin(lines, "/finance", [], "Open finance");
    }
    case "ads_client_new":
      return fin([
        "🤝 New ads client",
        `Client: ${p.client}`,
        ...(s(p.business) ? [`Business: ${p.business}`] : []),
        ...(s(p.won_by) ? [`Won by: ${p.won_by}`] : []),
        "Next: connect their Meta app and ad account.",
      ], `/ads/clients/${s(p.ads_client_id) ?? ""}`, [], "Open client");
    case "ad_account_problem":
      return fin([
        "⚠️ Ad account needs attention",
        `Account: ${p.account_name}`,
        ...(s(p.client) ? [`Client: ${p.client}`] : []),
        ...(s(p.error) ? [`Meta said: ${p.error}`] : []),
        "Syncing is paused until the token or access is fixed.",
      ], s(p.ads_client_id) ? `/ads/clients/${p.ads_client_id}` : "/ads", [], "Open");
    case "test":
      return fin(["✅ Test message", `Hi ${p.name}, Telegram notifications from the CRM are working.`], "/dashboard");
  }
}

/** Text only (kept for callers and tests that only need the message body). */
export function buildNotificationMessage(n: ClaimedNotification, appUrl: string | null): string {
  return buildNotification(n, appUrl).text;
}

/** Removes anything that looks like a bot token or URL and bounds the length. */
export function sanitizeError(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, "<redacted>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .slice(0, 300);
}

type TelegramBody = { ok?: boolean; description?: string; error_code?: number; parameters?: { retry_after?: number }; result?: { message_id?: number } };

/** Maps a Telegram Bot API response to a delivery outcome. `status` 0 = network error/timeout. */
export function classifyTelegramResult(status: number, body: TelegramBody | null): DeliveryOutcome {
  if (status === 200 && body?.ok) return { result: "sent", messageId: body.result?.message_id ?? null };
  const description = sanitizeError(body?.description ?? (status === 0 ? "network error" : `HTTP ${status}`));
  if (status === 429) {
    return { result: "retry", error: `rate limited: ${description}`, retryAfterSeconds: body?.parameters?.retry_after ?? 30, rateLimited: true };
  }
  if (status === 403 || (status === 400 && /chat not found|user is deactivated/i.test(description))) {
    return { result: "blocked", error: description };
  }
  if (status === 0 || status >= 500) return { result: "retry", error: description, retryAfterSeconds: null, rateLimited: false };
  return { result: "failed", error: description };
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
