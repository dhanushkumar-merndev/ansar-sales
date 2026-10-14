import { z } from "zod";
import { normalizePhone } from "@/lib/phone";

/** Most leads one import may hold (the database refuses more). */
export const MAX_IMPORT_ROWS = 500;

export type ImportField = "name" | "phone" | "email" | "company" | "niche" | "stage" | "owner" | "note";

/** The template's columns, in order. `aliases`: other headings accepted for the same column. */
export const IMPORT_COLUMNS: { field: ImportField; header: string; width: number; aliases: string[]; adminOnly?: boolean }[] = [
  { field: "name", header: "Name", width: 24, aliases: ["full name", "lead name", "lead", "customer name"] },
  { field: "phone", header: "Phone", width: 18, aliases: ["mobile", "phone number", "mobile number", "contact", "contact number", "whatsapp"] },
  { field: "email", header: "Email", width: 26, aliases: ["e-mail", "email address", "mail"] },
  { field: "company", header: "Company", width: 22, aliases: ["company name", "business", "organisation", "organization"] },
  { field: "niche", header: "Niche", width: 18, aliases: ["category"] },
  { field: "stage", header: "Stage", width: 14, aliases: ["status"] },
  { field: "owner", header: "Owner", width: 18, aliases: ["assigned to", "salesperson", "sales person"], adminOnly: true },
  { field: "note", header: "Note", width: 36, aliases: ["notes", "remarks", "remark", "comment", "comments"] },
];

const HEADER_TO_FIELD = new Map<string, ImportField>(
  IMPORT_COLUMNS.flatMap((c) => [[c.header.toLowerCase(), c.field] as const, ...c.aliases.map((a) => [a, c.field] as const)]),
);
const headerKey = (v: string) => v.replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** One data row of the file: its Excel row number and the text of each recognised column. */
export type ParsedRow = { row: number; values: Partial<Record<ImportField, string>> };
export type ParsedFile = { rows: ParsedRow[]; missingColumns: ImportField[]; tooMany: boolean };

/** Text of an ExcelJS cell value: rich text, links (emails often become links), formulas and dates included. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as { richText?: { text: string }[]; text?: unknown; result?: unknown; hyperlink?: string };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("").trim();
    if (v.text !== undefined) return cellText(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (v.hyperlink) return v.hyperlink.replace(/^mailto:/i, "").trim();
    return "";
  }
  return String(value).trim();
}

/** Reads the first sheet: row 1 is the heading row, empty rows are skipped, at most 500 rows are kept. */
export async function parseLeadFile(data: ArrayBuffer): Promise<ParsedFile> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], missingColumns: ["name", "phone"], tooMany: false };
  const columns = new Map<number, ImportField>();
  ws.getRow(1).eachCell((cell, col) => {
    const field = HEADER_TO_FIELD.get(headerKey(cellText(cell.value)));
    if (field && ![...columns.values()].includes(field)) columns.set(col, field);
  });
  const found = new Set(columns.values());
  const missingColumns = (["name", "phone"] as const).filter((f) => !found.has(f));
  const rows: ParsedRow[] = [];
  let tooMany = false;
  ws.eachRow((r, rowNumber) => {
    if (rowNumber === 1 || tooMany) return;
    const values: ParsedRow["values"] = {};
    for (const [col, field] of columns) {
      const text = cellText(r.getCell(col).value);
      if (text) values[field] = text;
    }
    if (!Object.keys(values).length) return;
    if (rows.length === MAX_IMPORT_ROWS) { tooMany = true; return; }
    rows.push({ row: rowNumber, values });
  });
  return { rows, missingColumns, tooMany };
}

/** What a checked row becomes: the lead to send, or why it can't be imported. */
export type CheckedRow = {
  row: number;
  values: ParsedRow["values"];
  errors: string[];
  /** Its phone is already a lead in this company (skipped unless the user imports duplicates). */
  inCrm: boolean;
  lead: ImportLead | null;
};

/** One lead as sent to the server (re-validated there with `importLeadSchema`). */
export type ImportLead = {
  name: string; phone: string; email?: string; companyName?: string;
  niche: { id?: string; newName?: string }; stageId?: string; ownerId?: string; note?: string;
};

export type CheckContext = {
  /** Used when a row has no Niche. */
  defaultNiche: { id?: string; newName?: string } | null;
  stages: { id: string; name: string }[];
  /** Admins: people a row may be given to (by name), and who gets rows without an Owner. Sales: null. */
  owners: { id: string; display_name: string }[] | null;
  defaultOwnerId?: string;
  /** Normalized phones already in the CRM (from lead_phones_in_crm). */
  inCrm: Set<string>;
};

const emailSchema = z.email();
const lower = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();

/** Checks every row in the browser, the same way the server will, so problems show before anything is sent. */
export function checkLeadRows(rows: ParsedRow[], ctx: CheckContext): CheckedRow[] {
  const seenPhones = new Map<string, number>();
  const stageByName = new Map(ctx.stages.map((s) => [lower(s.name), s.id]));
  return rows.map(({ row, values }) => {
    const errors: string[] = [];
    const name = values.name?.trim() ?? "";
    if (!name) errors.push("Name is missing");
    else if (name.length > 120) errors.push("Name is longer than 120 characters");

    const phone = values.phone ? normalizePhone(values.phone) : null;
    if (!values.phone) errors.push("Phone is missing");
    else if (!phone) errors.push("Phone isn't a valid number (add +country code for non-Indian numbers)");
    else if (seenPhones.has(phone.e164)) errors.push(`Same phone as row ${seenPhones.get(phone.e164)}`);
    else seenPhones.set(phone.e164, row);

    const email = values.email?.trim();
    if (email && (email.length > 254 || !emailSchema.safeParse(email).success)) errors.push("Email isn't valid");
    const company = values.company?.trim();
    if (company && company.length > 120) errors.push("Company is longer than 120 characters");
    const note = values.note?.trim();
    if (note && note.length > 5000) errors.push("Note is longer than 5,000 characters");

    let niche: ImportLead["niche"] | null = null;
    const nicheText = values.niche?.trim();
    if (nicheText) {
      if (nicheText.length > 60) errors.push("Niche is longer than 60 characters");
      else niche = { newName: nicheText };
    } else if (ctx.defaultNiche) niche = ctx.defaultNiche;
    else errors.push("Niche is missing: fill it in or choose a default niche above");

    let stageId: string | undefined;
    if (values.stage) {
      stageId = stageByName.get(lower(values.stage));
      if (!stageId) errors.push(`Stage "${values.stage}" isn't one of: ${ctx.stages.map((s) => s.name).join(", ")}`);
    }

    let ownerId: string | undefined;
    if (ctx.owners) {
      if (values.owner) {
        const matches = ctx.owners.filter((o) => lower(o.display_name) === lower(values.owner!));
        if (matches.length === 1) ownerId = matches[0].id;
        else errors.push(matches.length ? `Owner "${values.owner}" matches more than one person` : `Owner "${values.owner}" isn't an active salesperson or admin`);
      } else ownerId = ctx.defaultOwnerId;
    }

    const lead: ImportLead | null = errors.length || !phone || !niche ? null : {
      name, phone: phone.display, niche,
      ...(email ? { email } : {}), ...(company ? { companyName: company } : {}), ...(note ? { note } : {}),
      ...(stageId ? { stageId } : {}), ...(ownerId ? { ownerId } : {}),
    };
    return { row, values, errors, inCrm: Boolean(phone && ctx.inCrm.has(phone.e164)), lead };
  });
}

/** The template: the heading row, one example, and a sheet explaining each column with this company's stages. */
export async function leadImportTemplate(opts: { stages: string[]; admin: boolean }): Promise<ArrayBuffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const columns = IMPORT_COLUMNS.filter((c) => opts.admin || !c.adminOnly);
  const ws = wb.addWorksheet("Leads", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.field === "name" || c.field === "phone" ? `${c.header}*` : c.header, width: c.width }));
  ws.getRow(1).font = { bold: true };
  // Phones as text, so Excel keeps "+91" and leading zeros.
  ws.getColumn(columns.findIndex((c) => c.field === "phone") + 1).numFmt = "@";
  const example: Record<ImportField, string> = {
    name: "Ravi Kumar", phone: "+91 98765 43210", email: "ravi@example.com", company: "Ravi Builders",
    niche: "Real estate", stage: opts.stages[0] ?? "", owner: "", note: "Asked for a call back next week",
  };
  ws.addRow(columns.map((c) => example[c.field]));

  const help = wb.addWorksheet("How to fill");
  help.columns = [{ header: "Column", width: 14 }, { header: "What to put", width: 90 }];
  help.getRow(1).font = { bold: true };
  const explain: Record<ImportField, string> = {
    name: "Required. The person's name.",
    phone: "Required. Indian numbers can be 10 digits; other countries need +country code. A number already in the CRM is skipped unless you choose to import it anyway.",
    email: "Optional.",
    company: "Optional. The lead's company.",
    niche: "Optional. Leave empty to use the default niche you pick on the import screen. A new name creates the niche.",
    stage: `Optional. One of: ${opts.stages.join(", ") || "your pipeline stages"}. Empty means the first stage.`,
    owner: "Optional. The salesperson's or admin's name exactly as shown in Users. Empty means the default owner you pick on the import screen.",
    note: "Optional. Saved as the first note on the lead's timeline.",
  };
  for (const c of columns) help.addRow([c.header, explain[c.field]]);
  help.addRow([]);
  help.addRow(["Limit", `At most ${MAX_IMPORT_ROWS} leads per file. Delete the example row before importing.`]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** The rows that weren't imported, as they were in the file plus an "Error" column, to fix and upload again. */
export async function problemRowsWorkbook(rows: { values: ParsedRow["values"]; error: string }[], admin: boolean): Promise<ArrayBuffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const columns = IMPORT_COLUMNS.filter((c) => admin || !c.adminOnly);
  const ws = wb.addWorksheet("Leads", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [...columns.map((c) => ({ header: c.header, width: c.width })), { header: "Error", width: 50 }];
  ws.getRow(1).font = { bold: true };
  ws.getColumn(columns.findIndex((c) => c.field === "phone") + 1).numFmt = "@";
  for (const r of rows) ws.addRow([...columns.map((c) => r.values[c.field] ?? ""), r.error]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** Messages for the database's per-row errors. */
export const IMPORT_ROW_ERRORS: Record<string, string> = {
  duplicate_phone: "Already in the CRM",
  invalid_owner: "The owner can't take leads here",
  niche_not_found: "The niche no longer exists",
  invalid_stage: "The stage no longer exists",
  forbidden: "You can't add leads",
};
