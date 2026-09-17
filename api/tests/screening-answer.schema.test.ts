import { describe, it, expect } from "vitest";
import { ScreeningAnswerRequestSchema } from "../src/lib/schemas.js";

describe("ScreeningAnswerRequestSchema — valid data", () => {
  it("accepts a normal question/answer pair", () => {
    const result = ScreeningAnswerRequestSchema.safeParse({
      question: "Are you willing to relocate?",
      answer: "Yes, open to relocating within the US.",
    });
    expect(result.success).toBe(true);
  });

  it("trims surrounding whitespace on both fields", () => {
    const result = ScreeningAnswerRequestSchema.safeParse({
      question: "  Expected hourly rate?  ",
      answer: "  $25/hr  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.question).toBe("Expected hourly rate?");
      expect(result.data.answer).toBe("$25/hr");
    }
  });

  it("accepts an answer up to 4000 characters", () => {
    const result = ScreeningAnswerRequestSchema.safeParse({
      question: "Tell us about a project you're proud of.",
      answer: "x".repeat(4000),
    });
    expect(result.success).toBe(true);
  });
});

describe("ScreeningAnswerRequestSchema — rejects invalid data", () => {
  it("rejects a blank question", () => {
    const result = ScreeningAnswerRequestSchema.safeParse({ question: "", answer: "Yes." });
    expect(result.success).toBe(false);
  });

  it("rejects a question that's only whitespace", () => {
    const result = ScreeningAnswerRequestSchema.safeParse({ question: "   ", answer: "Yes." });
    expect(result.success).toBe(false);
  });

  it("rejects a blank answer", () => {
    const result = ScreeningAnswerRequestSchema.safeParse({ question: "Willing to relocate?", answer: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a question over 500 characters", () => {
    const result = ScreeningAnswerRequestSchema.safeParse({ question: "x".repeat(501), answer: "Yes." });
    expect(result.success).toBe(false);
  });

  it("rejects an answer over 4000 characters", () => {
    const result = ScreeningAnswerRequestSchema.safeParse({ question: "Q", answer: "x".repeat(4001) });
    expect(result.success).toBe(false);
  });

  it("rejects a missing question", () => {
    const result = ScreeningAnswerRequestSchema.safeParse({ answer: "Yes." });
    expect(result.success).toBe(false);
  });

  it("rejects a missing answer", () => {
    const result = ScreeningAnswerRequestSchema.safeParse({ question: "Q" });
    expect(result.success).toBe(false);
  });
});
