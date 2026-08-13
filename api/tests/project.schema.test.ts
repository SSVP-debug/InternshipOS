import { describe, it, expect } from "vitest";
import { ProjectRequestSchema } from "../src/lib/schemas.js";

describe("ProjectRequestSchema — valid data", () => {
  it("accepts a minimal valid project (title + description only)", () => {
    const result = ProjectRequestSchema.safeParse({
      title: "InternshipOS",
      description: "An internship application intelligence platform.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a real-world-shaped project like Code Club", () => {
    const result = ProjectRequestSchema.safeParse({
      title: "Code Club",
      description: "Ran weekly programming workshops for first-year students.",
      role: "team lead",
      team_size: 5,
      start_date: "2024-09-01",
      end_date: "2025-05-15",
      is_ongoing: false,
      tech_stack: ["Python", "Flask"],
      external_url: "https://example.edu/code-club",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an ongoing project with no end_date", () => {
    const result = ProjectRequestSchema.safeParse({
      title: "InternshipOS",
      description: "Ongoing platform build.",
      start_date: "2026-06-01",
      is_ongoing: true,
    });
    expect(result.success).toBe(true);
  });

  it("defaults is_ongoing to false and tech_stack to an empty array", () => {
    const result = ProjectRequestSchema.safeParse({
      title: "InternshipOS",
      description: "Ongoing platform build.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_ongoing).toBe(false);
      expect(result.data.tech_stack).toEqual([]);
    }
  });

  it("trims surrounding whitespace from title and description", () => {
    const result = ProjectRequestSchema.safeParse({
      title: "  InternshipOS  ",
      description: "  A platform.  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("InternshipOS");
      expect(result.data.description).toBe("A platform.");
    }
  });
});

describe("ProjectRequestSchema — required-field validation", () => {
  it("rejects a missing title", () => {
    const result = ProjectRequestSchema.safeParse({ description: "Something." });
    expect(result.success).toBe(false);
  });

  it("rejects an empty title", () => {
    const result = ProjectRequestSchema.safeParse({ title: "", description: "Something." });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only title", () => {
    const result = ProjectRequestSchema.safeParse({ title: "   ", description: "Something." });
    expect(result.success).toBe(false);
  });

  it("rejects a missing description", () => {
    const result = ProjectRequestSchema.safeParse({ title: "InternshipOS" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty description", () => {
    const result = ProjectRequestSchema.safeParse({ title: "InternshipOS", description: "" });
    expect(result.success).toBe(false);
  });
});

describe("ProjectRequestSchema — invalid data rejection", () => {
  it("rejects end_date before start_date", () => {
    const result = ProjectRequestSchema.safeParse({
      title: "InternshipOS",
      description: "A platform.",
      start_date: "2026-06-01",
      end_date: "2025-01-01",
    });
    expect(result.success).toBe(false);
  });

  it("accepts end_date exactly equal to start_date (boundary)", () => {
    const result = ProjectRequestSchema.safeParse({
      title: "Hackathon Project",
      description: "Built in 24 hours.",
      start_date: "2026-06-01",
      end_date: "2026-06-01",
    });
    expect(result.success).toBe(true);
  });

  it("rejects is_ongoing = true combined with an end_date", () => {
    const result = ProjectRequestSchema.safeParse({
      title: "InternshipOS",
      description: "A platform.",
      start_date: "2026-06-01",
      end_date: "2026-08-01",
      is_ongoing: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive team_size", () => {
    const result = ProjectRequestSchema.safeParse({
      title: "InternshipOS",
      description: "A platform.",
      team_size: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed external_url", () => {
    const result = ProjectRequestSchema.safeParse({
      title: "InternshipOS",
      description: "A platform.",
      external_url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed date string", () => {
    const result = ProjectRequestSchema.safeParse({
      title: "InternshipOS",
      description: "A platform.",
      start_date: "06/01/2026",
    });
    expect(result.success).toBe(false);
  });

  it("never has a verification/evidence field — Project facts stay unverified in Phase 0", () => {
    // ProjectRequestSchema is wrapped in .refine() calls (ZodEffects), so
    // its .shape isn't directly reachable — instead, verify that even if a
    // caller sends a "verified" field, it's silently stripped/never
    // surfaces in the parsed, persisted data.
    const result = ProjectRequestSchema.safeParse({
      title: "InternshipOS",
      description: "A platform.",
      verified: true,
      evidence_backed: true,
      is_verified: true,
    } as unknown as Record<string, unknown>);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.verified).toBeUndefined();
      expect(data.evidence_backed).toBeUndefined();
      expect(data.is_verified).toBeUndefined();
    }
  });
});
