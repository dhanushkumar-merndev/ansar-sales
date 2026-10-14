import { describe, expect, it } from "vitest";
import { parseFormAnswers, readableAnswer, readableQuestion } from "@/lib/form-answers";
import { mapLeadFields } from "@/lib/meta";

describe("Facebook form answers", () => {
  it("turns option keys into words and leaves typed answers alone", () => {
    expect(readableAnswer("within_1_month")).toBe("Within 1 month");
    expect(readableAnswer("yes,_this_fits_our_budget.")).toBe("Yes, this fits our budget.");
    expect(readableAnswer("real_estate")).toBe("Real estate");
    expect(readableAnswer("Prophill")).toBe("Prophill");
    expect(readableAnswer("my_email is a_b@x.com")).toBe("my_email is a_b@x.com");
  });

  it("labels field names and keeps questions as asked", () => {
    expect(readableQuestion("company_name")).toBe("Company name");
    expect(readableQuestion("what best describes your business?")).toBe("What best describes your business?");
  });

  it("reads an older note into question/answer pairs", () => {
    const body = "Facebook form answers:\nWhen are you planning to implement a real estate crm?: within_1_month\nCompany name: Prophill";
    expect(parseFormAnswers(body)).toEqual([
      { question: "When are you planning to implement a real estate crm?", answer: "Within 1 month" },
      { question: "Company name", answer: "Prophill" },
    ]);
    expect(parseFormAnswers("Called, no answer")).toBeNull();
  });

  it("stores readable answers for new leads", () => {
    const f = mapLeadFields({
      id: "1",
      field_data: [
        { name: "full_name", values: ["Asha"] },
        { name: "how_would_you_prefer_to_explore_our_crm?", values: ["schedule_a_consultation_call"] },
        { name: "company_name", values: ["Prophill"] },
      ],
    });
    expect(f.answers).toBe("How would you prefer to explore our crm?: Schedule a consultation call\nCompany name: Prophill");
  });
});
