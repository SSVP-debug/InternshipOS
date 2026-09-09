import { describe, it, expect } from "vitest";
import { extractSponsorshipSignal } from "../src/lib/ingestion/extractEligibilitySignals.js";

describe("extractSponsorshipSignal", () => {
  it("returns true for an explicit, unambiguous sponsorship-offered statement", () => {
    expect(
      extractSponsorshipSignal(
        "Software Engineering Intern",
        "We are a growing startup. Visa sponsorship available for exceptional candidates."
      )
    ).toBe(true);
  });

  it("returns true when the positive phrase appears in the title", () => {
    expect(extractSponsorshipSignal("Intern Role — Willing to sponsor a visa", null)).toBe(true);
  });

  it("returns false for an explicit, unambiguous sponsorship-not-offered statement", () => {
    expect(
      extractSponsorshipSignal(
        "Marketing Intern",
        "This role does not offer visa sponsorship. Candidates must already have work authorization."
      )
    ).toBe(false);
  });

  it("returns false for a differently-worded negative phrase", () => {
    expect(
      extractSponsorshipSignal("Data Intern", "Unfortunately we are unable to sponsor a visa for this position.")
    ).toBe(false);
  });

  it("returns null when no sponsorship-related text is present at all", () => {
    expect(
      extractSponsorshipSignal("Backend Development Intern", "Join our engineering team building REST APIs.")
    ).toBeNull();
  });

  it("returns null for a null description and a title with no sponsorship phrase", () => {
    expect(extractSponsorshipSignal("Operations Internship", null)).toBeNull();
  });

  it("returns null (never guesses) when both a positive and a negative phrase are present", () => {
    expect(
      extractSponsorshipSignal(
        "Intern",
        "Visa sponsorship available for our US office, but we will not sponsor a visa for the remote track."
      )
    ).toBeNull();
  });

  it("does not false-positive on unrelated senses of 'sponsor' without 'visa'", () => {
    // Event/programme sponsorship — a real, plausible internship-posting
    // sentence that must NOT be read as an immigration-sponsorship signal.
    expect(
      extractSponsorshipSignal(
        "Events Intern",
        "You'll help coordinate our conference sponsorship program and manage sponsor relationships."
      )
    ).toBeNull();
  });

  it("does not false-positive on the bare word 'visa' without a sponsorship phrase", () => {
    expect(
      extractSponsorshipSignal("Travel Intern", "You'll help process visa applications for our clients.")
    ).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extractSponsorshipSignal("Intern", "VISA SPONSORSHIP AVAILABLE for this role.")).toBe(true);
  });
});
