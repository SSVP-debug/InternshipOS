import { describe, it, expect } from "vitest";
import { ResumeCreateRequestSchema, ResumeUpdateRequestSchema, ResumeSkillRequestSchema } from "../src/lib/schemas.js";

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

describe("ResumeCreateRequestSchema", () => {
  it("accepts a minimal valid record (label only)", () => {
    const result = ResumeCreateRequestSchema.safeParse({ label: "Software Development" });
    expect(result.success).toBe(true);
  });

  it("accepts label + target_role_category + evidence_source_id", () => {
    const result = ResumeCreateRequestSchema.safeParse({
      label: "AI/ML",
      target_role_category: "Machine Learning",
      evidence_source_id: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing label", () => {
    const result = ResumeCreateRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an empty/whitespace-only label", () => {
    expect(ResumeCreateRequestSchema.safeParse({ label: "" }).success).toBe(false);
    expect(ResumeCreateRequestSchema.safeParse({ label: "   " }).success).toBe(false);
  });

  it("trims the label", () => {
    const result = ResumeCreateRequestSchema.safeParse({ label: "  Data Science  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.label).toBe("Data Science");
  });

  it("rejects an empty/whitespace-only target_role_category if supplied", () => {
    expect(ResumeCreateRequestSchema.safeParse({ label: "x", target_role_category: "" }).success).toBe(false);
  });

  it("rejects a non-UUID evidence_source_id", () => {
    const result = ResumeCreateRequestSchema.safeParse({ label: "x", evidence_source_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("does not accept is_active at creation time (stripped, not validated) — a resume is always created active", () => {
    const result = ResumeCreateRequestSchema.safeParse({ label: "x", is_active: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).is_active).toBeUndefined();
    }
  });
});

describe("ResumeUpdateRequestSchema", () => {
  it("accepts an empty object — every field is optional", () => {
    const result = ResumeUpdateRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts is_active — this is the archive/unarchive mechanism", () => {
    const result = ResumeUpdateRequestSchema.safeParse({ is_active: false });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.is_active).toBe(false);
  });

  it("accepts an explicit null target_role_category to clear it", () => {
    const result = ResumeUpdateRequestSchema.safeParse({ target_role_category: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.target_role_category).toBeNull();
  });

  it("accepts an explicit null evidence_source_id to clear it", () => {
    const result = ResumeUpdateRequestSchema.safeParse({ evidence_source_id: null });
    expect(result.success).toBe(true);
  });

  it("rejects an empty/whitespace-only label if supplied", () => {
    expect(ResumeUpdateRequestSchema.safeParse({ label: "   " }).success).toBe(false);
  });

  it("rejects a non-UUID evidence_source_id", () => {
    expect(ResumeUpdateRequestSchema.safeParse({ evidence_source_id: "not-a-uuid" }).success).toBe(false);
  });
});

describe("ResumeSkillRequestSchema", () => {
  it("accepts a valid skill_id", () => {
    const result = ResumeSkillRequestSchema.safeParse({ skill_id: VALID_UUID });
    expect(result.success).toBe(true);
  });

  it("rejects a missing skill_id", () => {
    expect(ResumeSkillRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-UUID skill_id", () => {
    expect(ResumeSkillRequestSchema.safeParse({ skill_id: "not-a-uuid" }).success).toBe(false);
  });
});
