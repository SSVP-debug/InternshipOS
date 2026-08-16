import { describe, it, expect } from "vitest";
import { ClaimRequestSchema, ClaimStatusTransitionSchema } from "../src/lib/schemas.js";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

describe("ClaimRequestSchema — valid data", () => {
  it("accepts a minimal valid claim (no evidence_source_id)", () => {
    const result = ClaimRequestSchema.safeParse({
      subject_entity_type: "project",
      subject_entity_id: VALID_UUID,
      claim_text: "Built a full-stack platform using React and Node.js.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a claim with evidence_source_id provided", () => {
    const result = ClaimRequestSchema.safeParse({
      subject_entity_type: "project",
      subject_entity_id: VALID_UUID,
      claim_text: "Built a full-stack platform.",
      evidence_source_id: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it("accepts each defined subject_entity_type", () => {
    for (const subject_entity_type of [
      "education",
      "work_authorization",
      "skill",
      "project",
      "experience",
      "achievement",
      "certification",
    ]) {
      const result = ClaimRequestSchema.safeParse({
        subject_entity_type,
        subject_entity_id: VALID_UUID,
        claim_text: "Some claim text.",
      });
      expect(result.success, `subject_entity_type "${subject_entity_type}" should be valid`).toBe(true);
    }
  });

  it("trims surrounding whitespace from claim_text", () => {
    const result = ClaimRequestSchema.safeParse({
      subject_entity_type: "skill",
      subject_entity_id: VALID_UUID,
      claim_text: "  Proficient in TypeScript  ",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.claim_text).toBe("Proficient in TypeScript");
  });

  it("never accepts a status field — status changes go through the dedicated transition endpoint only", () => {
    const result = ClaimRequestSchema.safeParse({
      subject_entity_type: "skill",
      subject_entity_id: VALID_UUID,
      claim_text: "Proficient in TypeScript",
      status: "CONFIRMED",
    } as unknown as Record<string, unknown>);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.status).toBeUndefined();
    }
  });
});

describe("ClaimRequestSchema — validation failures", () => {
  it("rejects an empty claim_text", () => {
    const result = ClaimRequestSchema.safeParse({
      subject_entity_type: "skill",
      subject_entity_id: VALID_UUID,
      claim_text: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only claim_text", () => {
    const result = ClaimRequestSchema.safeParse({
      subject_entity_type: "skill",
      subject_entity_id: VALID_UUID,
      claim_text: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized subject_entity_type", () => {
    const result = ClaimRequestSchema.safeParse({
      subject_entity_type: "hobby",
      subject_entity_id: VALID_UUID,
      claim_text: "Some claim.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid subject_entity_id", () => {
    const result = ClaimRequestSchema.safeParse({
      subject_entity_type: "skill",
      subject_entity_id: "not-a-uuid",
      claim_text: "Some claim.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid evidence_source_id", () => {
    const result = ClaimRequestSchema.safeParse({
      subject_entity_type: "skill",
      subject_entity_id: VALID_UUID,
      claim_text: "Some claim.",
      evidence_source_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

describe("ClaimStatusTransitionSchema — valid data", () => {
  it("accepts each transitionable status", () => {
    for (const status of ["CONFIRMED", "DISPUTED", "SUPERSEDED", "REVOKED"]) {
      const result = ClaimStatusTransitionSchema.safeParse({ status });
      expect(result.success, `status "${status}" should be a valid transition target`).toBe(true);
    }
  });
});

describe("ClaimStatusTransitionSchema — validation failures", () => {
  it("rejects DRAFT — nothing ever transitions back into DRAFT", () => {
    const result = ClaimStatusTransitionSchema.safeParse({ status: "DRAFT" });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized status value", () => {
    const result = ClaimStatusTransitionSchema.safeParse({ status: "APPROVED" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing status", () => {
    const result = ClaimStatusTransitionSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
