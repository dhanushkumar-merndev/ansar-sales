import { describe, expect, it } from "vitest";
import { navFor } from "@/lib/permissions";

describe("sidebar", () => {
  it("shows Team to admins and architect managers in companies with Projects, not to designers", () => {
    expect(navFor(["architect_manager"], ["projects"])).toContain("team");
    expect(navFor(["admin"], ["projects"])).toContain("team");
    expect(navFor(["landscape_designer"], ["projects"])).not.toContain("team");
    expect(navFor(["execution"], ["projects"])).not.toContain("team");
    expect(navFor(["admin"], [])).not.toContain("team"); // Projects switched off
  });

  it("hides Ads and Automation where Star Growth Hub runs the ads (no_ads)", () => {
    expect(navFor(["admin"], [])).toEqual(expect.arrayContaining(["ads", "automation"]));
    expect(navFor(["admin"], ["projects", "no_ads"])).not.toContain("ads");
    expect(navFor(["admin"], ["projects", "no_ads"])).not.toContain("automation");
    expect(navFor(["ads_manager"], ["no_ads"])).toEqual([]);
  });

  it("shows only the leads module inside an ads client's CRM", () => {
    const ws = ["client_workspace", "no_ads"];
    expect(navFor(["admin"], ws)).toEqual(["dashboard", "leads", "follow-ups", "ad-results", "users"]);
    expect(navFor(["sales"], ws)).toEqual(["dashboard", "leads", "follow-ups", "ad-results"]);
  });
});
