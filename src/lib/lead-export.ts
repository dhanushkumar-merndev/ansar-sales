import "server-only";
import ExcelJS from "exceljs";
import { formatDateTime } from "@/lib/time";

/** One row of public.export_leads. */
export type ExportedLead = {
  id: string; name: string; company_name: string | null; phone: string; email: string | null;
  niche: string | null; stage: string | null; status: "open" | "won" | "lost"; owner: string | null;
  source: "manual" | "facebook" | null; created_at: string; next_follow_up_at: string | null;
};

const STATUS = { open: "Open", won: "Won", lost: "Lost" } as const;
const SOURCE = { manual: "Added in CRM", facebook: "Facebook form" } as const;

const COLUMNS: { header: string; width: number; value: (l: ExportedLead) => string }[] = [
  { header: "Name", width: 26, value: (l) => l.name },
  { header: "Company", width: 24, value: (l) => l.company_name ?? "" },
  { header: "Phone", width: 18, value: (l) => l.phone },
  { header: "Email", width: 28, value: (l) => l.email ?? "" },
  { header: "Niche", width: 18, value: (l) => l.niche ?? "" },
  { header: "Stage", width: 16, value: (l) => l.stage ?? "" },
  { header: "Result", width: 10, value: (l) => STATUS[l.status] ?? l.status },
  { header: "Owner", width: 18, value: (l) => l.owner ?? "" },
  { header: "Source", width: 16, value: (l) => (l.source ? SOURCE[l.source] ?? l.source : "") },
  { header: "Added (IST)", width: 22, value: (l) => formatDateTime(l.created_at) },
  { header: "Next follow-up (IST)", width: 22, value: (l) => (l.next_follow_up_at ? formatDateTime(l.next_follow_up_at) : "") },
];

/**
 * The leads as an .xlsx workbook. Every cell is text, so Excel keeps "+91…" phone numbers and the
 * IST date-times exactly as the CRM shows them.
 */
export async function leadsWorkbook(leads: ExportedLead[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet("Leads", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width }));
  ws.getRow(1).font = { bold: true };
  for (const l of leads) ws.addRow(COLUMNS.map((c) => c.value(l)));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const LEAD_EXPORT_HEADERS = COLUMNS.map((c) => c.header);
