import { describe, it, expect } from "vitest";
import {
  ApplicationCreateRequestSchema,
  ApplicationUpdateRequestSchema,
  ApplicationStatusTransitionSchema,
} from "../src/lib/schemas.js";

const validOpportunityId = "11111111-1111-1111-1111-111111111111";

describe("ApplicationCreateRequestSchema", () => {
  it("accepts a minimal valid record (opportunity_id only)", () => {
    const result = ApplicationCreateRequestSchema.safeParse({ opportunity_id: validOpportunityId });
    expect(result.success).toBe(true);
  });

  it("accepts a full valid record", () => {
    const result = ApplicationCreateRequestSchema.safeParse({
      opportunity_id: validOpportunityId,
      deadline_override: "2026-04-01",
      next_action_date: "2026-02-01",
      next_action_note: "Submit portfolio.",
      recruiter_name: "Jane Doe",
      recruiter_email: "jane@acme.example",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing opportunity_id", () => {
    const result = ApplicationCreateRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a non-UUID opportunity_id", () => {
    const result = ApplicationCreateRequestSchema.safeParse({ opportunity_id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed recruiter_email", () => {
    const result = ApplicationCreateRequestSchema.safeParse({
      opportunity_id: validOpportunityId,
      recruiter_email: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  it("ignores a status field if supplied (stripped, not validated) — status only changes via the transition endpoint", () => {
    const result = ApplicationCreateRequestSchema.safeParse({
      opportunity_id: validOpportunityId,
      status: "OFFER",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).status).toBeUndefined();
    }
  });
});

describe("ApplicationUpdateRequestSchema", () => {
  it("accepts an empty body (all fields optional — a no-op PUT is valid)", () => {
    const result = ApplicationUpdateRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a partial update", () => {
    const result = ApplicationUpdateRequestSchema.safeParse({ next_action_note: "Call back Monday." });
    expect(result.success).toBe(true);
  });

  it("does not include opportunity_id or status as editable fields (stripped, not validated)", () => {
    const result = ApplicationUpdateRequestSchema.safeParse({
      opportunity_id: validOpportunityId,
      status: "WITHDRAWN",
      next_action_note: "x",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).opportunity_id).toBeUndefined();
      expect((result.data as Record<string, unknown>).status).toBeUndefined();
    }
  });
});

describe("ApplicationStatusTransitionSchema", () => {
  it("accepts each of the eight defined statuses", () => {
    const statuses = ["SAVED", "APPLYING", "APPLIED", "ASSESSMENT", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"];
    for (const status of statuses) {
      const result = ApplicationStatusTransitionSchema.safeParse({ status });
      expect(result.success, `expected ${status} to be accepted`).toBe(true);
    }
  });

  it("accepts an optional note alongside status", () => {
    const result = ApplicationStatusTransitionSchema.safeParse({
      status: "INTERVIEW",
      note: "Onsite scheduled for next week.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unrecognized status", () => {
    const result = ApplicationStatusTransitionSchema.safeParse({ status: "GHOSTED" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing status", () => {
    const result = ApplicationStatusTransitionSchema.safeParse({ note: "no status supplied" });
    expect(result.success).toBe(false);
  });
});
