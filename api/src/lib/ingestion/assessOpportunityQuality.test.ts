import { describe, expect, it } from "vitest";
import { assessOpportunityQuality } from "./assessOpportunityQuality.js";

const base = {
  title: "Software Engineering Intern",
  company: "Example Technologies",
  description: "Build backend APIs with our engineering team.",
  sourceUrl: "https://jobs.example.com/role/123",
  applicationUrl: "https://jobs.example.com/role/123/apply",
};

describe("assessOpportunityQuality", () => {
  it("marks an ordinary listing clear", () => {
    expect(assessOpportunityQuality(base)).toEqual({
      quality_status: "clear",
      quality_score: 100,
      quality_flags: [],
    });
  });

  it("marks explicit fee language high risk", () => {
    const result = assessOpportunityQuality({
      ...base,
      description: "Pay a registration fee to confirm your internship.",
    });
    expect(result.quality_status).toBe("high_risk");
    expect(result.quality_flags).toContain("fee_request_language");
  });

  it("marks payment pressure high risk", () => {
    const result = assessOpportunityQuality({
      ...base,
      description: "Pay today. Limited slots only.",
    });
    expect(result.quality_status).toBe("high_risk");
    expect(result.quality_flags).toContain("urgency_or_payment_pressure");
  });

  it("treats WhatsApp-only contact as a review signal, not proof of fraud", () => {
    const result = assessOpportunityQuality({
      ...base,
      description: "WhatsApp only for application.",
    });
    expect(result.quality_status).toBe("review");
    expect(result.quality_flags).toContain("whatsapp_only_contact");
  });

  it("treats free-mail recruiter addresses as a review signal", () => {
    const result = assessOpportunityQuality({
      ...base,
      description: "Contact recruiter@example@gmail.com",
    });
    expect(result.quality_status).toBe("review");
    expect(result.quality_flags).toContain("free_mail_recruiter_contact");
  });

  it("does not flag a company-domain email", () => {
    const result = assessOpportunityQuality({
      ...base,
      description: "Contact jobs@example.com",
    });
    expect(result.quality_flags).not.toContain("free_mail_recruiter_contact");
  });

  it("records missing URLs without discarding the listing", () => {
    const result = assessOpportunityQuality({
      ...base,
      sourceUrl: null,
      applicationUrl: null,
    });
    expect(result.quality_status).toBe("review");
    expect(result.quality_flags).toEqual([
      "missing_application_url",
      "missing_source_url",
    ]);
  });

  it("does not treat a generic sponsor mention as a fee request", () => {
    const result = assessOpportunityQuality({
      ...base,
      description: "Our event sponsors support the student community.",
    });
    expect(result.quality_status).toBe("clear");
  });
});
