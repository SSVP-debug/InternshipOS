import { describe, it, expect } from "vitest";
import {
  SignupRequestSchema,
  PersonalInfoRequestSchema,
  ConsentRequestSchema,
} from "../src/lib/schemas.js";

describe("SignupRequestSchema", () => {
  it("accepts a valid signup payload", () => {
    const result = SignupRequestSchema.safeParse({
      email: "alice@example.edu",
      password: "supersecret1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid email", () => {
    const result = SignupRequestSchema.safeParse({
      email: "not-an-email",
      password: "supersecret1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a short password", () => {
    const result = SignupRequestSchema.safeParse({
      email: "alice@example.edu",
      password: "short",
    });
    expect(result.success).toBe(false);
  });
});

describe("PersonalInfoRequestSchema", () => {
  it("accepts a minimal valid payload", () => {
    const result = PersonalInfoRequestSchema.safeParse({
      legal_first_name: "Alice",
      legal_last_name: "Nguyen",
      email: "alice@example.edu",
      location_country: "US",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing location_country", () => {
    const result = PersonalInfoRequestSchema.safeParse({
      legal_first_name: "Alice",
      legal_last_name: "Nguyen",
      email: "alice@example.edu",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty legal_first_name", () => {
    const result = PersonalInfoRequestSchema.safeParse({
      legal_first_name: "",
      legal_last_name: "Nguyen",
      email: "alice@example.edu",
      location_country: "US",
    });
    expect(result.success).toBe(false);
  });

  it("never has a field for government ID or date of birth by design", () => {
    // Structural test, not just a runtime check: this locks in the Phase 0
    // PII boundary decision (no SSN/DOB collection) at the schema level.
    const keys = Object.keys(PersonalInfoRequestSchema.shape);
    expect(keys).not.toContain("ssn");
    expect(keys).not.toContain("date_of_birth");
    expect(keys).not.toContain("government_id");
  });
});

describe("ConsentRequestSchema", () => {
  it("accepts each defined consent_type", () => {
    for (const type of [
      "data_processing",
      "github_oauth_access",
      "llm_processing",
      "document_upload_storage",
    ]) {
      expect(ConsentRequestSchema.safeParse({ consent_type: type }).success).toBe(true);
    }
  });

  it("rejects an unrecognized consent_type", () => {
    const result = ConsentRequestSchema.safeParse({ consent_type: "marketing_emails" });
    expect(result.success).toBe(false);
  });
});
