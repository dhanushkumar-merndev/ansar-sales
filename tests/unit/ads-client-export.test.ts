import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { adsClientWorkbook, EXPORT_SHEETS } = await import("@/lib/ads-client-export");

describe("deleted client workbook", () => {
  it("has every sheet, phones as text, money as numbers and times in IST", async () => {
    const file = await adsClientWorkbook({
      leads: [{ name: "Walk-in", phone: "+919876543210", created_at: "2026-10-13T06:30:00Z" }],
      campaigns: [{ name: "Villa leads", spend: 500.5, leads: 3 }],
      logins: [{ username: "ravi", active: false }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(EXPORT_SHEETS.map((s) => s.title));
    const leads = wb.getWorksheet("Leads")!;
    expect(leads.getRow(1).font?.bold).toBe(true);
    expect(leads.getRow(2).getCell(3).value).toBe("+919876543210");
    expect(String(leads.getRow(2).getCell(10).value)).toMatch(/13 Oct 2026.*12:00/);
    expect(wb.getWorksheet("Campaigns")!.getRow(2).getCell(7).value).toBe(500.5);
    expect(wb.getWorksheet("Logins")!.getRow(2).getCell(6).value).toBe("No");
    expect(wb.getWorksheet("Daily results")!.rowCount).toBe(1);
  });
});
