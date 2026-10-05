// All timestamps are stored in UTC and shown/entered in the business timezone.
// Asia/Kolkata has a fixed +05:30 offset (no DST), which keeps conversion exact.
export const BUSINESS_TZ = "Asia/Kolkata";
const IST_OFFSET = "+05:30";

const dateTimeFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: BUSINESS_TZ, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
});
const dateFmt = new Intl.DateTimeFormat("en-IN", { timeZone: BUSINESS_TZ, day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: BUSINESS_TZ, hour: "numeric", minute: "2-digit", hour12: true });
const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const monthFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "short", year: "numeric" });
const dayLabelFmt = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "2026-10-05" + "14:30" (IST wall clock) → UTC ISO string. */
export function istToUtcIso(date: string, time: string): string {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) throw new Error("Invalid date or time");
  const d = new Date(`${date}T${time}:00${IST_OFFSET}`);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid date or time");
  return d.toISOString();
}

/** UTC instant → IST wall-clock parts { date: "YYYY-MM-DD", time: "HH:mm" }. */
export function utcToIstParts(value: string | Date): { date: string; time: string } {
  const parts = Object.fromEntries(partsFmt.formatToParts(new Date(value)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function istToday(now: Date = new Date()): string {
  return utcToIstParts(now).date;
}

/** Start of an IST calendar day as a UTC ISO instant. */
export function istDayStartUtc(date: string): string {
  return istToUtcIso(date, "00:00");
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const formatDateTime = (value: string | Date) => dateTimeFmt.format(new Date(value));
export const formatDate = (value: string | Date) => dateFmt.format(new Date(value));
export const formatTime = (value: string | Date) => timeFmt.format(new Date(value));
/** Formats a plain calendar date ("YYYY-MM-DD") without timezone shifting. */
export const formatCalendarDate = (date: string) => dateFmt.format(new Date(`${date}T12:00:00${IST_OFFSET}`));
export const formatMonth = (date: string) => monthFmt.format(new Date(`${date.slice(0, 7)}-01T00:00:00Z`));
export const formatDayLabel = (date: string) => dayLabelFmt.format(new Date(`${date}T00:00:00Z`));

/** Short relative description used next to due times, e.g. "in 2 h", "3 d ago". */
export function formatRelative(value: string | Date, now: Date = new Date()): string {
  const diffMs = new Date(value).getTime() - now.getTime();
  const abs = Math.abs(diffMs);
  const minutes = Math.round(abs / 60_000);
  let text: string;
  if (minutes < 1) return "now";
  if (minutes < 60) text = `${minutes} min`;
  else if (minutes < 60 * 24) text = `${Math.round(minutes / 60)} h`;
  else text = `${Math.round(minutes / 1440)} d`;
  return diffMs >= 0 ? `in ${text}` : `${text} ago`;
}
