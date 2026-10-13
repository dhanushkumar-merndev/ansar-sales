// The bell's items. The text comes from the reminder worker's own describeNotification, so the app and
// Telegram always say the same thing.
import { describeNotification, type NotificationKind } from "../../supabase/functions/reminder-worker/logic";

export type AppNotification = { id: string; kind: string; payload: Record<string, unknown>; created_at: string; read_at: string | null };
export type AppNotificationPage = { items: AppNotification[]; total: number; unread: number };

/** Leading emoji of the first line, e.g. "📤 Phase sent for review" → icon "📤", title "Phase sent for review". */
const EMOJI = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/u;

export type ShownNotification = { icon: string; title: string; company: string | null; details: string[]; href: string };

/** Title, a few detail lines and the link for one item. */
export function showNotification(n: Pick<AppNotification, "kind" | "payload">, now = new Date()): ShownNotification {
  const d = describeNotification(n.kind as NotificationKind, n.payload ?? {}, now);
  const [first = "", ...rest] = d.lines;
  const m = first.match(EMOJI);
  const company = rest[0]?.startsWith("🏢 ") ? rest[0].slice(3) : null;
  const details = (company ? rest.slice(1) : rest).filter((l) => l.trim() !== "");
  return { icon: m?.[1] ?? "🔔", title: m ? first.slice(m[0].length) : first, company, details, href: d.path || "/dashboard" };
}

/**
 * Where a link leads from inside the app: the page itself, and the company to switch to first when it
 * belongs to another one (the super admin's and ads managers' `/switch?company=…&next=…` links).
 */
export function notificationTarget(href: string, currentCompanyId: string): { path: string; switchTo: string | null } {
  const url = new URL(href, "http://crm.local");
  if (url.pathname !== "/switch") return { path: href, switchTo: null };
  const next = url.searchParams.get("next") ?? "";
  const company = url.searchParams.get("company");
  return { path: next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard", switchTo: company && company !== currentCompanyId ? company : null };
}

/** "Today", "Yesterday" or a date, in IST, for grouping the full list. */
export function notificationDay(iso: string, now = new Date()) {
  const ist = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
  const day = ist(new Date(iso));
  if (day === ist(now)) return "Today";
  if (day === ist(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}
