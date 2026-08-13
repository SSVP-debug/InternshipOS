import { describe, it, expect } from "vitest";
import { ExperienceRequestSchema } from "../src/lib/schemas.js";

const validBase = {
  organization: "Acme Corp",
  title: "Software Engineering Intern",
  employment_type: "internship" as const,
  start_date: "2026-06-01",
  description_raw: "Built internal tooling for the platform team.",
};

describe("ExperienceRequestSchema — valid creation", () => {
  it("accepts a minimal valid experience (no end_date, no location)", () => {
    const result = ExperienceRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("accepts a full valid experience including end_date and location", () => {
    const result = ExperienceRequestSchema.safeParse({
      ...validBase,
      end_date: "2026-08-15",
      location: "Remote",
    });
    expect(result.success).toBe(true);
  });

  it("defaults is_current to false when omitted", () => {
    const result = ExperienceRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.is_current).toBe(false);
  });

  it("accepts each defined employment_type", () => {
    for (const employment_type of ["internship", "part_time", "full_time", "research", "volunteer"]) {
      const result = ExperienceRequestSchema.safeParse({ ...validBase, employment_type });
      expect(result.success, `employment_type "${employment_type}" should be valid`).toBe(true);
    }
  });

  it("trims surrounding whitespace from organization, title, and description_raw", () => {
    const result = ExperienceRequestSchema.safeParse({
      ...validBase,
      organization: "  Acme Corp  ",
      title: "  Intern  ",
      description_raw: "  Did things.  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.organization).toBe("Acme Corp");
      expect(result.data.title).toBe("Intern");
      expect(result.data.description_raw).toBe("Did things.");
    }
  });
});

describe("ExperienceRequestSchema — required-field validation", () => {
  it("rejects a missing organization", () => {
    const { organization, ...rest } = validBase;
    expect(ExperienceRequestSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an empty title", () => {
    const result = ExperienceRequestSchema.safeParse({ ...validBase, title: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing start_date", () => {
    const { start_date, ...rest } = validBase;
    expect(ExperienceRequestSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing description_raw", () => {
    const { description_raw, ...rest } = validBase;
    expect(ExperienceRequestSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a whitespace-only description_raw", () => {
    const result = ExperienceRequestSchema.safeParse({ ...validBase, description_raw: "   " });
    expect(result.success).toBe(false);
  });
});

describe("ExperienceRequestSchema — invalid enum/data rejection", () => {
  it("rejects an unrecognized employment_type", () => {
    const result = ExperienceRequestSchema.safeParse({ ...validBase, employment_type: "contract" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed start_date", () => {
    const result = ExperienceRequestSchema.safeParse({ ...validBase, start_date: "06/01/2026" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed end_date", () => {
    const result = ExperienceRequestSchema.safeParse({ ...validBase, end_date: "08/15/2026" });
    expect(result.success).toBe(false);
  });

  it("never has a verification/credibility field", () => {
    const result = ExperienceRequestSchema.safeParse({
      ...validBase,
      verified: true,
      credibility_score: 0.9,
    } as unknown as Record<string, unknown>);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.verified).toBeUndefined();
      expect(data.credibility_score).toBeUndefined();
    }
  });
});

describe("ExperienceRequestSchema — date consistency", () => {
  it("rejects end_date before start_date", () => {
    const result = ExperienceRequestSchema.safeParse({
      ...validBase,
      start_date: "2026-06-01",
      end_date: "2026-01-01",
    });
    expect(result.success).toBe(false);
  });

  it("accepts end_date exactly equal to start_date (boundary)", () => {
    const result = ExperienceRequestSchema.safeParse({
      ...validBase,
      start_date: "2026-06-01",
      end_date: "2026-06-01",
    });
    expect(result.success).toBe(true);
  });
});

describe("ExperienceRequestSchema — ongoing/current experience rules", () => {
  it("accepts is_current = true with no end_date", () => {
    const result = ExperienceRequestSchema.safeParse({ ...validBase, is_current: true });
    expect(result.success).toBe(true);
  });

  it("rejects is_current = true combined with an end_date", () => {
    const result = ExperienceRequestSchema.safeParse({
      ...validBase,
      is_current: true,
      end_date: "2026-08-15",
    });
    expect(result.success).toBe(false);
  });

  it("accepts is_current = false with an end_date (a finished role)", () => {
    const result = ExperienceRequestSchema.safeParse({
      ...validBase,
      is_current: false,
      end_date: "2026-08-15",
    });
    expect(result.success).toBe(true);
  });

  it("accepts is_current = false with no end_date (unfinished, not marked current)", () => {
    const result = ExperienceRequestSchema.safeParse({ ...validBase, is_current: false });
    expect(result.success).toBe(true);
  });
});
