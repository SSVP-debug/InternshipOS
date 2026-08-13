import { describe, it, expect } from "vitest";
import { AchievementRequestSchema } from "../src/lib/schemas.js";

describe("AchievementRequestSchema — valid data", () => {
  it("accepts a minimal valid achievement (title + date_awarded only)", () => {
    const result = AchievementRequestSchema.safeParse({
      title: "Dean's List",
      date_awarded: "2026-01-15",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full valid achievement including all optional fields", () => {
    const result = AchievementRequestSchema.safeParse({
      title: "HackMIT Winner",
      issuing_body: "HackMIT",
      date_awarded: "2026-09-20",
      rank_or_result: "1st place",
      verification_url: "https://hackmit.org/results/2026",
    });
    expect(result.success).toBe(true);
  });

  it("trims surrounding whitespace from title", () => {
    const result = AchievementRequestSchema.safeParse({
      title: "  Dean's List  ",
      date_awarded: "2026-01-15",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe("Dean's List");
  });
});

describe("AchievementRequestSchema — required-field validation", () => {
  it("rejects a missing title", () => {
    const result = AchievementRequestSchema.safeParse({ date_awarded: "2026-01-15" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty title", () => {
    const result = AchievementRequestSchema.safeParse({ title: "", date_awarded: "2026-01-15" });
    expect(result.success).toBe(false);
  });

  it("rejects a whitespace-only title", () => {
    const result = AchievementRequestSchema.safeParse({ title: "   ", date_awarded: "2026-01-15" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing date_awarded", () => {
    const result = AchievementRequestSchema.safeParse({ title: "Dean's List" });
    expect(result.success).toBe(false);
  });
});

describe("AchievementRequestSchema — invalid data rejection", () => {
  it("rejects a malformed date_awarded", () => {
    const result = AchievementRequestSchema.safeParse({
      title: "Dean's List",
      date_awarded: "01/15/2026",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed verification_url", () => {
    const result = AchievementRequestSchema.safeParse({
      title: "HackMIT Winner",
      date_awarded: "2026-09-20",
      verification_url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("never has a verification/credibility flag — verification_url is a plain link, not a status field", () => {
    const result = AchievementRequestSchema.safeParse({
      title: "Dean's List",
      date_awarded: "2026-01-15",
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
