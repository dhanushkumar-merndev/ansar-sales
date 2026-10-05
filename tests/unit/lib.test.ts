import { describe, expect, it } from "vitest";
import { addDays, formatDateTime, istToUtcIso, istToday, utcToIstParts } from "@/lib/time";
import { lastPage, parsePaging, rangeFor, toPageResult } from "@/lib/pagination";
import { normalizePhone } from "@/lib/phone";
import { cleanSearch, escapeLike } from "@/lib/search";
import { createRequestGate, isAbortError } from "@/lib/request-gate";
import { parseStartCommand } from "@/lib/telegram";
import { leadCreateSchema, expenseSchema, usernameSchema } from "@/lib/validation";

describe("IST date/time handling", () => {
  it("converts IST wall clock to UTC and back regardless of host timezone", () => {
    expect(istToUtcIso("2026-10-05", "14:30")).toBe("2026-10-05T09:00:00.000Z");
    expect(istToUtcIso("2026-10-06", "00:15")).toBe("2026-10-05T18:45:00.000Z");
    expect(utcToIstParts("2026-10-05T18:45:00Z")).toEqual({ date: "2026-10-06", time: "00:15" });
    expect(istToday(new Date("2026-10-05T19:00:00Z"))).toBe("2026-10-06");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(formatDateTime("2026-10-05T09:00:00Z")).toMatch(/5 Oct 2026.*2:30\s?pm/i);
  });
  it("rejects malformed input", () => {
    expect(() => istToUtcIso("2026-13-40", "10:00")).toThrow();
    expect(() => istToUtcIso("2026-10-05", "25:00")).toThrow();
  });
});

describe("pagination contract", () => {
  const p = (q: string) => parsePaging(new URLSearchParams(q));
  it("parses one-based pages and allowlisted sizes", () => {
    expect(p("")).toEqual({ page: 1, pageSize: 20, offset: 0 });
    expect(p("page=3&pageSize=50")).toEqual({ page: 3, pageSize: 50, offset: 100 });
    expect(p("page=-2&pageSize=1000")).toEqual({ page: 1, pageSize: 20, offset: 0 });
    expect(p("page=abc")).toEqual({ page: 1, pageSize: 20, offset: 0 });
  });
  it("uses inclusive ranges without an extra row", () => {
    expect(rangeFor(1, 20)).toEqual([0, 19]);
    expect(rangeFor(2, 20)).toEqual([20, 39]);
  });
  it("computes next page and last valid page", () => {
    expect(toPageResult([], 41, 2, 20).hasNextPage).toBe(true);
    expect(toPageResult([], 40, 2, 20).hasNextPage).toBe(false);
    expect(lastPage(0, 20)).toBe(1);
    expect(lastPage(41, 20)).toBe(3);
  });
});

describe("request gate (stale response protection)", () => {
  it("only the newest request may apply its result, older ones are aborted", async () => {
    const gate = createRequestGate();
    const applied: string[] = [];
    const slow = gate.begin();
    const fast = gate.begin();
    expect(slow.signal.aborted).toBe(true);
    await Promise.all([
      new Promise<void>((r) => setTimeout(() => { if (slow.isLatest()) applied.push("slow"); r(); }, 20)),
      new Promise<void>((r) => setTimeout(() => { if (fast.isLatest()) applied.push("fast"); r(); }, 5)),
    ]);
    expect(applied).toEqual(["fast"]);
    gate.cancel();
    expect(fast.isLatest()).toBe(false);
  });
  it("recognises abort errors", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("boom"))).toBe(false);
  });
});

describe("input normalization", () => {
  it("normalizes phones with country code support", () => {
    expect(normalizePhone("98765 43210")).toEqual({ e164: "+919876543210", display: "+91 98765 43210" });
    expect(normalizePhone("+1 (415) 555-2671")?.e164).toBe("+14155552671");
    expect(normalizePhone("12345")).toBeNull();
  });
  it("escapes LIKE wildcards and bounds search", () => {
    expect(escapeLike("50%_off\\*")).toBe("50\\%\\_off\\\\");
    expect(cleanSearch("  a   b ")).toBe("a b");
    expect(cleanSearch("x".repeat(200))).toHaveLength(100);
  });
  it("validates usernames and lead input", () => {
    expect(usernameSchema.parse("  Ravi.K ")).toBe("ravi.k");
    expect(usernameSchema.safeParse("a").success).toBe(false);
    const ok = leadCreateSchema.safeParse({ name: " Acme ", phone: "9876543210", email: "", niche: { newName: "Retail" } });
    expect(ok.success && ok.data).toMatchObject({ name: "Acme", phone: { e164: "+919876543210" }, email: undefined, status: "new" });
    expect(leadCreateSchema.safeParse({ name: "A", phone: "9876543210", niche: {} }).success).toBe(false);
    expect(leadCreateSchema.safeParse({ name: "A", phone: "abc", niche: { newName: "x" } }).success).toBe(false);
  });
  it("accepts exact money strings only", () => {
    expect(expenseSchema.safeParse({ expenseDate: "2026-10-01", category: "rent", amount: "1999.99" }).success).toBe(true);
    expect(expenseSchema.safeParse({ expenseDate: "2026-10-01", category: "rent", amount: "1.999" }).success).toBe(false);
    expect(expenseSchema.safeParse({ expenseDate: "2026-10-01", category: "rent", amount: "0" }).success).toBe(false);
  });
});

describe("telegram /start parsing", () => {
  const token = "a".repeat(64);
  it("accepts only private /start with a well-formed token", () => {
    expect(parseStartCommand({ message: { text: `/start ${token}`, chat: { id: 5, type: "private" }, from: { username: "u" } } })).toEqual({ token, chatId: 5, username: "u" });
    expect(parseStartCommand({ message: { text: `/start ${token}`, chat: { id: 5, type: "group" } } })).toBeNull();
    expect(parseStartCommand({ message: { text: "/start nope", chat: { id: 5, type: "private" } } })).toBeNull();
    expect(parseStartCommand(null)).toBeNull();
  });
});
