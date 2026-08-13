import { describe, it, expect } from "vitest";
import { CertificationRequestSchema } from "../src/lib/schemas.js";

const validBase = {
  name: "AWS Certified Cloud Practitioner",
  issuer: "Amazon Web Services",
  issue_date: "2026-03-01",
};

describe("CertificationRequestSchema — valid certification", () => {
  it("accepts a minimal valid certification (name, issuer, issue_date only)", () => {
    const result = CertificationRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("accepts a full valid certification including all optional fields", () => {
    const result = CertificationRequestSchema.safeParse({
      ...validBase,
      expiry_date: "2029-03-01",
      credential_id: "AWS-CCP-123456",
      verification_url: "https://aws.amazon.com/verification/123456",
    });
    expect(result.success).toBe(true);
  });

  it("trims surrounding whitespace from name and issuer", () => {
    const result = CertificationRequestSchema.safeParse({
      ...validBase,
      name: "  AWS Certified Cloud Practitioner  ",
      issuer: "  Amazon Web Services  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("AWS Certified Cloud Practitioner");
      expect(result.data.issuer).toBe("Amazon Web Services");
    }
  });
});

describe("CertificationRequestSchema — required-field validation", () => {
  it("rejects a missing name", () => {
    const { name, ...rest } = validBase;
    expect(CertificationRequestSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an empty name", () => {
    const result = CertificationRequestSchema.safeParse({ ...validBase, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only issuer", () => {
    const result = CertificationRequestSchema.safeParse({ ...validBase, issuer: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects a missing issue_date", () => {
    const { issue_date, ...rest } = validBase;
    expect(CertificationRequestSchema.safeParse(rest).success).toBe(false);
  });
});

describe("CertificationRequestSchema — optional-field validation", () => {
  it("is valid when expiry_date, credential_id, and verification_url are all omitted", () => {
    const result = CertificationRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expiry_date).toBeUndefined();
      expect(result.data.credential_id).toBeUndefined();
      expect(result.data.verification_url).toBeUndefined();
    }
  });

  it("accepts expiry_date exactly equal to issue_date (boundary)", () => {
    const result = CertificationRequestSchema.safeParse({
      ...validBase,
      expiry_date: validBase.issue_date,
    });
    expect(result.success).toBe(true);
  });
});

describe("CertificationRequestSchema — invalid data rejection", () => {
  it("rejects expiry_date before issue_date", () => {
    const result = CertificationRequestSchema.safeParse({
      ...validBase,
      issue_date: "2026-03-01",
      expiry_date: "2020-01-01",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed issue_date", () => {
    const result = CertificationRequestSchema.safeParse({ ...validBase, issue_date: "03/01/2026" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed expiry_date", () => {
    const result = CertificationRequestSchema.safeParse({
      ...validBase,
      expiry_date: "03/01/2029",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed verification_url", () => {
    const result = CertificationRequestSchema.safeParse({
      ...validBase,
      verification_url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("never has a credibility, ranking, score, or verification-status field", () => {
    const result = CertificationRequestSchema.safeParse({
      ...validBase,
      verified: true,
      credibility_score: 0.9,
      rank: 1,
    } as unknown as Record<string, unknown>);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.verified).toBeUndefined();
      expect(data.credibility_score).toBeUndefined();
      expect(data.rank).toBeUndefined();
    }
  });
});
