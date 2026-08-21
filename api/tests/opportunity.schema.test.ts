import { describe, it, expect } from "vitest";
import { OpportunityRequestSchema, OpportunityInboxUpdateSchema } from "../src/lib/schemas.js";

const validBase = {
  title: "Software Engineering Intern",
  company: "Acme Corp",
};

describe("OpportunityRequestSchema — valid data", () => {
  it("accepts a minimal valid record", () => {
    const result = OpportunityRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("defaults employment_type to internship, source to manual, skills to []", () => {
    const result = OpportunityRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.employment_type).toBe("internship");
      expect(result.data.source).toBe("manual");
      expect(result.data.skills).toEqual([]);
    }
  });

  it("accepts a full valid record", () => {
    const result = OpportunityRequestSchema.safeParse({
      ...validBase,
      description: "Work on the platform team.",
      location: "Remote",
      work_mode: "remote",
      employment_type: "co_op",
      skills: ["TypeScript", "React"],
      application_url: "https://acme.example/careers/123",
      source: "referral",
      deadline_date: "2026-03-01",
      posted_date: "2026-01-15",
    });
    expect(result.success).toBe(true);
  });
});

describe("OpportunityRequestSchema — validation failures", () => {
  it("rejects a blank title", () => {
    const result = OpportunityRequestSchema.safeParse({ ...validBase, title: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a blank company", () => {
    const result = OpportunityRequestSchema.safeParse({ ...validBase, company: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid work_mode", () => {
    const result = OpportunityRequestSchema.safeParse({ ...validBase, work_mode: "from_space" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid employment_type", () => {
    const result = OpportunityRequestSchema.safeParse({ ...validBase, employment_type: "apprenticeship" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid source", () => {
    const result = OpportunityRequestSchema.safeParse({ ...validBase, source: "carrier_pigeon" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed deadline_date", () => {
    const result = OpportunityRequestSchema.safeParse({ ...validBase, deadline_date: "03/01/2026" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-URL application_url", () => {
    const result = OpportunityRequestSchema.safeParse({ ...validBase, application_url: "not-a-url" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty string inside skills[]", () => {
    const result = OpportunityRequestSchema.safeParse({ ...validBase, skills: ["React", ""] });
    expect(result.success).toBe(false);
  });

  it("does not accept inbox_status or is_priority as create/update fields (stripped, not validated)", () => {
    // Zod object schemas strip unknown keys by default (no .strict()), so
    // this documents that these are silently ignored here — the real
    // enforcement is that the ROUTE never passes req.body.inbox_status
    // through to this schema's .insert()/.update() call; see
    // opportunity.ts's PATCH /opportunities/:id/inbox for the only path
    // that can actually change them.
    const result = OpportunityRequestSchema.safeParse({ ...validBase, inbox_status: "dismissed", is_priority: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).inbox_status).toBeUndefined();
    }
  });
});

describe("OpportunityInboxUpdateSchema", () => {
  it("accepts inbox_status alone", () => {
    const result = OpportunityInboxUpdateSchema.safeParse({ inbox_status: "saved" });
    expect(result.success).toBe(true);
  });

  it("accepts is_priority alone", () => {
    const result = OpportunityInboxUpdateSchema.safeParse({ is_priority: true });
    expect(result.success).toBe(true);
  });

  it("accepts both together", () => {
    const result = OpportunityInboxUpdateSchema.safeParse({ inbox_status: "dismissed", is_priority: false });
    expect(result.success).toBe(true);
  });

  it("rejects an empty body (at least one field required)", () => {
    const result = OpportunityInboxUpdateSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an invalid inbox_status value", () => {
    const result = OpportunityInboxUpdateSchema.safeParse({ inbox_status: "archived" });
    expect(result.success).toBe(false);
  });
});
