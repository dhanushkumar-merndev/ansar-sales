import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { LEAD_EXPORT_HEADERS, leadsWorkbook } = await import("@/lib/lead-export");

describe("leads workbook", () => {
  it("has a bold, frozen header row and keeps phones and IST times as text", async () => {
    const file = await leadsWorkbook([{
      id: "l1", name: "Hari", company_name: "Hari Builders", phone: "+919876543210", email: null, niche: "Villa",
      stage: "Contacted", status: "won", owner: "Diny", source: "facebook", created_at: "2026-10-13T06:30:00Z", next_follow_up_at: null,
    }]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Leads")!;
    expect(ws.getRow(1).values).toEqual([undefined, ...LEAD_EXPORT_HEADERS]);
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    const row = ws.getRow(2);
    expect(row.getCell(3).value).toBe("+919876543210");
    expect(row.getCell(7).value).toBe("Won");
    expect(row.getCell(9).value).toBe("Facebook form");
    expect(String(row.getCell(10).value)).toMatch(/13 Oct 2026.*12:00/i); // 06:30 UTC = 12:00 IST
    expect(row.getCell(11).value).toBe("");
  });
});
