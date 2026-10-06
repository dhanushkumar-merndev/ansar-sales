import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildNotification, type ClaimedNotification } from "../../supabase/functions/reminder-worker/logic";
import { adKpis, campaignStatusLabel, moneyFormat, objectiveLabel } from "../../src/lib/ads";
import { appSecretProof, budgetToMajor, dayWindows, mapActions, shiftDay, todayIn } from "../../src/lib/meta-ads";

describe("Meta actions", () => {
  it("takes the first matching lead and purchase type instead of adding overlapping ones", () => {
    const actions = [
      { action_type: "link_click", value: "40" },
      { action_type: "lead", value: "7" },
      { action_type: "onsite_conversion.lead_grouped", value: "7" },
      { action_type: "offsite_conversion.fb_pixel_purchase", value: "2" },
    ];
    expect(mapActions(actions, [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "1499.5" }]))
      .toEqual({ leads: 7, conversions: 2, conversion_value: 1499.5 });
    expect(mapActions(undefined, undefined)).toEqual({ leads: 0, conversions: 0, conversion_value: 0 });
  });

  it("converts budgets from minor units", () => {
    expect(budgetToMajor("150000", "INR")).toBe(1500);
    expect(budgetToMajor("5000", "JPY")).toBe(5000);
    expect(budgetToMajor(undefined, "INR")).toBeNull();
    expect(budgetToMajor("abc", "INR")).toBeNull();
  });

  it("signs every call with appsecret_proof (HMAC-SHA256 of the token)", () => {
    expect(appSecretProof("token", "secret")).toBe(createHmac("sha256", "secret").update("token").digest("hex"));
  });
});

describe("sync windows", () => {
  it("splits a range into 30-day windows without gaps", () => {
    const w = dayWindows("2026-01-01", "2026-03-05");
    expect(w[0]).toEqual({ since: "2026-01-01", until: "2026-01-30" });
    expect(w.at(-1)?.until).toBe("2026-03-05");
    for (let i = 1; i < w.length; i++) expect(shiftDay(w[i - 1].until, 1)).toBe(w[i].since);
  });

  it("uses the ad account's own calendar day", () => {
    const now = new Date("2026-10-05T20:00:00Z");
    expect(todayIn("Asia/Kolkata", now)).toBe("2026-10-06");
    expect(todayIn("America/Los_Angeles", now)).toBe("2026-10-05");
    expect(todayIn("Not/AZone", now)).toBe("2026-10-06");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("KPIs", () => {
  it("derives CTR, CPC, CPM, CPL, ROAS and frequency", () => {
    const k = adKpis({ spend: 2500, impressions: 4000, clicks: 200, leads: 15, conversions: 5, conversion_value: 10000 }, 3200);
    expect(k.ctr).toBe(5);
    expect(k.cpc).toBe(12.5);
    expect(k.cpm).toBe(625);
    expect(k.cpl).toBeCloseTo(166.667, 2);
    expect(k.costPerConversion).toBe(500);
    expect(k.roas).toBe(4);
    expect(k.frequency).toBe(1.25);
  });

  it("returns null instead of dividing by zero", () => {
    const k = adKpis({ spend: 100, impressions: 0, clicks: 0, leads: 0, conversions: 0, conversion_value: 0 });
    expect(Object.values(k).every((v) => v === null)).toBe(true);
  });

  it("formats money in the account's currency and labels Meta values", () => {
    expect(moneyFormat("INR")(1500)).toBe("₹1,500.00");
    expect(moneyFormat("USD")(12.5)).toContain("12.50");
    expect(moneyFormat("bad")(1)).toContain("₹");
    expect(campaignStatusLabel("ACTIVE")).toBe("Active");
    expect(campaignStatusLabel("SOMETHING_NEW")).toBe("Something new");
    expect(objectiveLabel("OUTCOME_LEADS")).toBe("Leads");
  });
});

describe("ads notifications", () => {
  const note = (kind: ClaimedNotification["kind"], payload: Record<string, unknown>): ClaimedNotification =>
    ({ notification_id: "n", lease_token: "t", chat_id: 1, kind, payload, attempts: 1 });

  it("announces a new ads client with a link that opens it in the right company", () => {
    const m = buildNotification(note("ads_client_new", { ads_client_id: "C1", client: "Rao Builders", business: "Real estate", won_by: "Priya", company: "Star Growth Hub", company_id: "CO" }), "https://crm.example.com");
    expect(m.text).toMatch(/^🤝 New ads client/);
    expect(m.text).toContain("Rao Builders");
    expect(m.text).toContain("🏢 Star Growth Hub");
    expect((m.buttons[0][0] as { url: string }).url).toBe(`https://crm.example.com/switch?company=CO&next=${encodeURIComponent("/ads/clients/C1")}`);
  });

  it("explains an ad account problem with Meta's message", () => {
    const m = buildNotification(note("ad_account_problem", { account_name: "Main", error: "Session expired" }), "https://crm.example.com");
    expect(m.text).toContain("Meta said: Session expired");
    expect((m.buttons[0][0] as { url: string }).url).toBe("https://crm.example.com/ads");
  });
});
