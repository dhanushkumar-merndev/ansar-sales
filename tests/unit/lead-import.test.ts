import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { cellText, checkLeadRows, IMPORT_COLUMNS, leadImportTemplate, MAX_IMPORT_ROWS, parseLeadFile, type ParsedRow, problemRowsWorkbook } from "@/lib/lead-import";

async function file(header: string[], rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

const stages = [{ id: "s-new", name: "New" }, { id: "s-call", name: "Contacted" }];
const ctx = (over: Partial<Parameters<typeof checkLeadRows>[1]> = {}) => ({
  defaultNiche: { id: "n1" }, stages, owners: null, inCrm: new Set<string>(), ...over,
});
const row = (n: number, values: ParsedRow["values"]): ParsedRow => ({ row: n, values });

describe("lead import file", () => {
  it("reads the template back, with its example row", async () => {
    const parsed = await parseLeadFile(await leadImportTemplate({ stages: ["New", "Contacted"], admin: true }));
    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.rows).toEqual([{ row: 2, values: expect.objectContaining({ name: "Ravi Kumar", phone: "+91 98765 43210", stage: "New" }) }]);
  });

  it("accepts other headings, links, numbers and skips empty rows", async () => {
    const parsed = await parseLeadFile(await file(["Full Name", "Mobile Number", "E-mail", "Remarks"], [
      ["Asha", 9876543210, { text: "asha@example.com", hyperlink: "mailto:asha@example.com" }, "Hot"],
      [],
      ["Bala", "+1 415 555 2671", null, null],
    ]));
    expect(parsed.rows).toEqual([
      { row: 2, values: { name: "Asha", phone: "9876543210", email: "asha@example.com", note: "Hot" } },
      { row: 4, values: { name: "Bala", phone: "+1 415 555 2671" } },
    ]);
  });

  it("says when Name or Phone columns are missing, and stops after 500 rows", async () => {
    expect((await parseLeadFile(await file(["Name", "City"], [["A", "B"]]))).missingColumns).toEqual(["phone"]);
    const big = await parseLeadFile(await file(["Name", "Phone"], Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => [`L${i}`, `98765${String(i).padStart(5, "0")}`])));
    expect(big.tooMany).toBe(true);
    expect(big.rows).toHaveLength(MAX_IMPORT_ROWS);
  });

  it("reads rich text and formula cells as text", () => {
    expect(cellText({ richText: [{ text: "Ra" }, { text: "vi" }] })).toBe("Ravi");
    expect(cellText({ formula: "A1", result: 42 })).toBe("42");
  });
});

describe("checking rows", () => {
  it("flags missing and invalid fields, and repeated phones within the file", () => {
    const out = checkLeadRows([
      row(2, { name: "Asha", phone: "98765 43210", email: "asha@example.com" }),
      row(3, { phone: "12" }),
      row(4, { name: "Asha again", phone: "+91 9876543210", email: "nope" }),
      row(5, { name: "Bad stage", phone: "9123456780", stage: "Won big" }),
    ], ctx());
    expect(out[0]).toMatchObject({ errors: [], lead: { name: "Asha", phone: "+91 98765 43210", email: "asha@example.com", niche: { id: "n1" } } });
    expect(out[1].errors).toEqual(["Name is missing", expect.stringMatching(/valid number/)]);
    expect(out[2].errors).toEqual(["Same phone as row 2", "Email isn't valid"]);
    expect(out[3].errors[0]).toMatch(/Stage "Won big" isn't one of: New, Contacted/);
  });

  it("uses the default niche, matches stages and owners by name, and marks phones already in the CRM", () => {
    const owners = [{ id: "u1", display_name: "Diny" }, { id: "u2", display_name: "Arun" }, { id: "u3", display_name: "Arun" }];
    const out = checkLeadRows([
      row(2, { name: "A", phone: "9876543210", stage: "contacted", owner: "diny", niche: "Villas" }),
      row(3, { name: "B", phone: "9876543211" }),
      row(4, { name: "C", phone: "9876543212", owner: "Arun" }),
      row(5, { name: "D", phone: "9876543213", owner: "Nobody" }),
    ], ctx({ owners, defaultOwnerId: "me", inCrm: new Set(["+919876543211"]) }));
    expect(out[0].lead).toMatchObject({ stageId: "s-call", ownerId: "u1", niche: { newName: "Villas" } });
    expect(out[1]).toMatchObject({ inCrm: true, lead: { ownerId: "me", niche: { id: "n1" } } });
    expect(out[2].errors[0]).toMatch(/more than one person/);
    expect(out[3].errors[0]).toMatch(/isn't an active salesperson/);
  });

  it("asks for a niche when there is no default", () => {
    expect(checkLeadRows([row(2, { name: "A", phone: "9876543210" })], ctx({ defaultNiche: null }))[0].errors[0]).toMatch(/Niche is missing/);
  });

  it("writes rows not imported with their reason", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await problemRowsWorkbook([{ values: { name: "A", phone: "+91 98765 43210" }, error: "Already in the CRM" }], false));
    const ws = wb.worksheets[0];
    const headers = IMPORT_COLUMNS.filter((c) => !c.adminOnly).map((c) => c.header);
    expect(ws.getRow(1).values).toEqual([undefined, ...headers, "Error"]);
    expect(ws.getRow(2).getCell(2).value).toBe("+91 98765 43210");
    expect(ws.getRow(2).getCell(headers.length + 1).value).toBe("Already in the CRM");
  });
});
