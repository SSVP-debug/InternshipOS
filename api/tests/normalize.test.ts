import { describe, it, expect } from "vitest";
import { cleanLine, cleanText, isInternshipRelevant, toIsoDate } from "../src/lib/ingestion/normalize.js";

describe("isInternshipRelevant", () => {
  it("matches 'intern', 'interns', 'internship', 'internships' as whole words", () => {
    expect(isInternshipRelevant("Software Intern", null)).toBe(true);
    expect(isInternshipRelevant("Hiring interns for summer", null)).toBe(true);
    expect(isInternshipRelevant("Marketing Internship", null)).toBe(true);
    expect(isInternshipRelevant("Multiple internships available", null)).toBe(true);
  });

  it("does not match 'international' or 'internet' as false positives", () => {
    expect(isInternshipRelevant("International Business Executive", null)).toBe(false);
    expect(isInternshipRelevant("Internet Marketing Specialist", null)).toBe(false);
  });

  it("checks the description when the title doesn't match", () => {
    expect(isInternshipRelevant("Student Program — Summer 2026", "This is a paid internship.")).toBe(true);
  });

  it("returns false when neither title nor description mentions internship", () => {
    expect(isInternshipRelevant("Senior Software Engineer", "5+ years experience required.")).toBe(false);
  });

  it("handles a null description without throwing", () => {
    expect(isInternshipRelevant("Design Intern", null)).toBe(true);
  });
});

describe("cleanText", () => {
  it("strips HTML tags and collapses whitespace", () => {
    expect(cleanText("<p>Join our  <b>team</b>\n\nas an intern.</p>")).toBe("Join our team as an intern.");
  });

  it("decodes a small set of common HTML entities", () => {
    expect(cleanText("Sales &amp; Marketing &nbsp; role")).toBe("Sales & Marketing role");
  });

  it("returns null for null, empty, or whitespace-only input", () => {
    expect(cleanText(null)).toBeNull();
    expect(cleanText("")).toBeNull();
    expect(cleanText("   ")).toBeNull();
  });
});

describe("cleanLine", () => {
  it("trims and collapses internal whitespace", () => {
    expect(cleanLine("  Bengaluru,   Karnataka  ")).toBe("Bengaluru, Karnataka");
  });

  it("returns null for null or empty input", () => {
    expect(cleanLine(null)).toBeNull();
    expect(cleanLine(undefined)).toBeNull();
    expect(cleanLine("")).toBeNull();
  });
});

describe("toIsoDate", () => {
  it("coerces an ISO timestamp to a YYYY-MM-DD date", () => {
    expect(toIsoDate("2026-08-15T06:12:00Z")).toBe("2026-08-15");
  });

  it("coerces a unix epoch (seconds) to a YYYY-MM-DD date", () => {
    // 1786000000s -> 2026-08-04T... (assert only the shape + a stable slice)
    const result = toIsoDate(1786000000);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns null for null, undefined, or empty input", () => {
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
    expect(toIsoDate("")).toBeNull();
  });

  it("returns null for an unparseable string instead of throwing", () => {
    expect(toIsoDate("not-a-date")).toBeNull();
  });
});
