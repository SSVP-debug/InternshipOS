import { describe, it, expect } from "vitest";
import { SkillRequestSchema } from "../src/lib/schemas.js";

describe("SkillRequestSchema — valid data", () => {
  it("accepts a minimal valid skill (no self_rating)", () => {
    const result = SkillRequestSchema.safeParse({ name: "Python", category: "language" });
    expect(result.success).toBe(true);
  });

  it("accepts a skill with self_rating provided", () => {
    const result = SkillRequestSchema.safeParse({
      name: "React",
      category: "framework",
      self_rating: "proficient",
    });
    expect(result.success).toBe(true);
  });

  it("accepts each defined category", () => {
    for (const category of ["language", "framework", "tool", "domain", "soft_skill"]) {
      const result = SkillRequestSchema.safeParse({ name: "Something", category });
      expect(result.success, `category "${category}" should be valid`).toBe(true);
    }
  });

  it("accepts each defined self_rating", () => {
    for (const self_rating of ["exposed", "proficient", "advanced"]) {
      const result = SkillRequestSchema.safeParse({ name: "Something", category: "tool", self_rating });
      expect(result.success, `self_rating "${self_rating}" should be valid`).toBe(true);
    }
  });

  it("trims surrounding whitespace from name", () => {
    const result = SkillRequestSchema.safeParse({ name: "  Docker  ", category: "tool" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Docker");
  });
});

describe("SkillRequestSchema — validation failures", () => {
  it("rejects an empty name", () => {
    const result = SkillRequestSchema.safeParse({ name: "", category: "language" });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only name", () => {
    const result = SkillRequestSchema.safeParse({ name: "   ", category: "language" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing name", () => {
    const result = SkillRequestSchema.safeParse({ category: "language" });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized category", () => {
    const result = SkillRequestSchema.safeParse({ name: "Python", category: "hobby" });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized self_rating", () => {
    const result = SkillRequestSchema.safeParse({
      name: "Python",
      category: "language",
      self_rating: "expert",
    });
    expect(result.success).toBe(false);
  });

  it("never has an evidence_backed field — it is a Phase-0 computed/DB-default field, not API-writable", () => {
    const keys = Object.keys(SkillRequestSchema.shape);
    expect(keys).not.toContain("evidence_backed");
  });
});
