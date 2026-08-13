import { describe, it, expect } from "vitest";
import { WorkAuthorizationRequestSchema } from "../src/lib/schemas.js";

const validBase = {
  citizenship_country: "IN",
  status: "f1_opt" as const,
  requires_sponsorship: true,
};

describe("WorkAuthorizationRequestSchema — valid data", () => {
  it("accepts a minimal valid record with no expiry date or notes", () => {
    const result = WorkAuthorizationRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("accepts a full valid record including optional expiry date and notes", () => {
    const result = WorkAuthorizationRequestSchema.safeParse({
      ...validBase,
      work_auth_expiry_date: "2027-06-30",
      notes: "STEM OPT extension filed, pending approval",
    });
    expect(result.success).toBe(true);
  });

  it("accepts requires_sponsorship = false explicitly (e.g. US citizen)", () => {
    const result = WorkAuthorizationRequestSchema.safeParse({
      citizenship_country: "US",
      status: "us_citizen",
      requires_sponsorship: false,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.requires_sponsorship).toBe(false);
  });
});

describe("WorkAuthorizationRequestSchema — optional expiry date", () => {
  it("is valid when work_auth_expiry_date is omitted entirely", () => {
    const result = WorkAuthorizationRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.work_auth_expiry_date).toBeUndefined();
  });

  it("rejects a malformed work_auth_expiry_date when provided", () => {
    const result = WorkAuthorizationRequestSchema.safeParse({
      ...validBase,
      work_auth_expiry_date: "06/30/2027",
    });
    expect(result.success).toBe(false);
  });
});

describe("WorkAuthorizationRequestSchema — enum validation", () => {
  it("accepts each defined status value", () => {
    const statuses = [
      "us_citizen",
      "permanent_resident",
      "f1_opt",
      "f1_cpt",
      "stem_opt_eligible",
      "h1b",
      "other_visa",
      "needs_sponsorship",
      "not_applicable_non_us",
    ];
    for (const status of statuses) {
      const result = WorkAuthorizationRequestSchema.safeParse({ ...validBase, status });
      expect(result.success, `status "${status}" should be valid`).toBe(true);
    }
  });

  it("rejects an unrecognized status", () => {
    const result = WorkAuthorizationRequestSchema.safeParse({ ...validBase, status: "tourist_visa" });
    expect(result.success).toBe(false);
  });
});

describe("WorkAuthorizationRequestSchema — required fields", () => {
  it("rejects a missing citizenship_country", () => {
    const { citizenship_country, ...rest } = validBase;
    const result = WorkAuthorizationRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a missing requires_sponsorship (must be stored explicitly, no default)", () => {
    const { requires_sponsorship, ...rest } = validBase;
    const result = WorkAuthorizationRequestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects requires_sponsorship provided as a non-boolean", () => {
    const result = WorkAuthorizationRequestSchema.safeParse({
      ...validBase,
      requires_sponsorship: "yes",
    });
    expect(result.success).toBe(false);
  });
});
