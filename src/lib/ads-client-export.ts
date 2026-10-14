import "server-only";
import ExcelJS from "exceljs";
import { formatDateTime } from "@/lib/time";

type Row = Record<string, unknown>;
type Column = { header: string; key: string; width: number; kind?: "date" | "number" | "yesno" };

/** The sheets of a deleted ads client's export, in order; `section` is the database's name for it. */
export const EXPORT_SHEETS: { section: string; title: string; columns: Column[] }[] = [
  { section: "client", title: "Client", columns: [
    { header: "Company", key: "company_name", width: 26 }, { header: "Contact", key: "contact", width: 22 },
    { header: "Industry", key: "industry", width: 18 }, { header: "Phone", key: "phone", width: 16 }, { header: "Email", key: "email", width: 26 },
    { header: "Status", key: "status", width: 12 }, { header: "Notes", key: "notes", width: 40 }, { header: "Run by", key: "agency", width: 20 },
    { header: "Client CRM", key: "crm", width: 22 }, { header: "Client since", key: "started_at", width: 20, kind: "date" },
    { header: "Closed", key: "closed_at", width: 20, kind: "date" }, { header: "Deleted", key: "deleted_at", width: 20, kind: "date" },
    { header: "Deleted by", key: "deleted_by", width: 18 },
  ] },
  { section: "logins", title: "Logins", columns: [
    { header: "Kind", key: "kind", width: 14 }, { header: "Username", key: "username", width: 20 }, { header: "Name", key: "name", width: 22 },
    { header: "Role", key: "role", width: 12 }, { header: "Also", key: "extra_roles", width: 16 }, { header: "Active", key: "active", width: 8, kind: "yesno" },
    { header: "Created", key: "created_at", width: 20, kind: "date" },
  ] },
  { section: "leads", title: "Leads", columns: [
    { header: "Name", key: "name", width: 24 }, { header: "Company", key: "company", width: 22 }, { header: "Phone", key: "phone", width: 16 },
    { header: "Email", key: "email", width: 26 }, { header: "Niche", key: "niche", width: 16 }, { header: "Stage", key: "stage", width: 14 },
    { header: "Result", key: "result", width: 10 }, { header: "Owner", key: "owner", width: 18 }, { header: "Source", key: "source", width: 12 },
    { header: "Added", key: "created_at", width: 20, kind: "date" }, { header: "Added by", key: "created_by", width: 18 },
    { header: "Archived", key: "archived_at", width: 20, kind: "date" },
  ] },
  { section: "timeline", title: "Timeline", columns: [
    { header: "Lead", key: "lead", width: 22 }, { header: "Phone", key: "phone", width: 16 }, { header: "When", key: "at", width: 20, kind: "date" },
    { header: "What", key: "type", width: 18 }, { header: "By", key: "by", width: 18 }, { header: "Text", key: "text", width: 50 },
    { header: "From", key: "from", width: 16 }, { header: "To", key: "to", width: 16 },
  ] },
  { section: "follow_ups", title: "Follow-ups", columns: [
    { header: "Lead", key: "lead", width: 22 }, { header: "Phone", key: "phone", width: 16 }, { header: "Task", key: "task", width: 36 },
    { header: "Due", key: "due_at", width: 20, kind: "date" }, { header: "State", key: "state", width: 12 }, { header: "Assignee", key: "assignee", width: 18 },
    { header: "Outcome", key: "outcome", width: 30 }, { header: "Created", key: "created_at", width: 20, kind: "date" },
    { header: "Completed", key: "completed_at", width: 20, kind: "date" }, { header: "Cancelled", key: "cancelled_at", width: 20, kind: "date" },
  ] },
  { section: "facebook", title: "Facebook leads", columns: [
    { header: "When", key: "at", width: 20, kind: "date" }, { header: "Form", key: "form", width: 22 }, { header: "Campaign", key: "campaign", width: 26 },
    { header: "Ad", key: "ad", width: 22 }, { header: "Result", key: "state", width: 12 }, { header: "Lead", key: "lead", width: 22 }, { header: "Error", key: "error", width: 30 },
  ] },
  { section: "ad_accounts", title: "Ad accounts", columns: [
    { header: "Source", key: "source", width: 28 }, { header: "Account ID", key: "act_id", width: 18 }, { header: "Name", key: "name", width: 22 },
    { header: "Currency", key: "currency", width: 10 }, { header: "Status", key: "status", width: 12 }, { header: "Connected", key: "created_at", width: 20, kind: "date" },
    { header: "Last synced", key: "last_synced_at", width: 20, kind: "date" }, { header: "Disconnected", key: "disconnected_at", width: 20, kind: "date" },
  ] },
  { section: "campaigns", title: "Campaigns", columns: [
    { header: "Source", key: "source", width: 28 }, { header: "Campaign ID", key: "campaign_id", width: 20 }, { header: "Name", key: "name", width: 30 },
    { header: "Objective", key: "objective", width: 16 }, { header: "Status", key: "status", width: 12 }, { header: "Created", key: "created_at", width: 20, kind: "date" },
    { header: "Spend", key: "spend", width: 12, kind: "number" }, { header: "Impressions", key: "impressions", width: 12, kind: "number" },
    { header: "Clicks", key: "clicks", width: 10, kind: "number" }, { header: "Link clicks", key: "link_clicks", width: 10, kind: "number" },
    { header: "Leads", key: "leads", width: 8, kind: "number" }, { header: "Conversions", key: "conversions", width: 10, kind: "number" },
    { header: "First day", key: "first_day", width: 12 }, { header: "Last day", key: "last_day", width: 12 },
  ] },
  { section: "daily", title: "Daily results", columns: [
    { header: "Date", key: "date", width: 12 }, { header: "Source", key: "source", width: 28 }, { header: "Campaign", key: "campaign", width: 30 },
    { header: "Spend", key: "spend", width: 12, kind: "number" }, { header: "Impressions", key: "impressions", width: 12, kind: "number" },
    { header: "Reach", key: "reach", width: 10, kind: "number" }, { header: "Clicks", key: "clicks", width: 10, kind: "number" },
    { header: "Link clicks", key: "link_clicks", width: 10, kind: "number" }, { header: "Leads", key: "leads", width: 8, kind: "number" },
    { header: "Conversions", key: "conversions", width: 10, kind: "number" },
  ] },
];

function cell(value: unknown, kind: Column["kind"]) {
  if (value === null || value === undefined || value === "") return "";
  if (kind === "number") return Number(value);
  if (kind === "yesno") return value ? "Yes" : "No";
  // Date-times as the CRM shows them (IST); everything else as text so Excel keeps "+91…" phones.
  if (kind === "date") return formatDateTime(String(value));
  return String(value);
}

/** One workbook, one sheet per section, every sheet with a frozen, filterable header row. */
export async function adsClientWorkbook(data: Record<string, Row[]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  for (const sheet of EXPORT_SHEETS) {
    const ws = wb.addWorksheet(sheet.title, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = sheet.columns.map((c) => ({ header: c.header, width: c.width }));
    ws.getRow(1).font = { bold: true };
    for (const row of data[sheet.section] ?? []) ws.addRow(sheet.columns.map((c) => cell(row[c.key], c.kind)));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
