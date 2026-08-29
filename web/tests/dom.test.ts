import { describe, it, expect, vi } from "vitest";
import { errorMessage, relativeTimeAgo } from "../src/lib/dom.js";

// Regression coverage for the secondary finding in the profile-persistence
// audit: every validation failure from the backend (education/skill/work-
// authorization/etc., all via z.safeParse().error.flatten()) used to
// surface to the user as the bare, unhelpful error code (e.g.
// "invalid_request"), with no indication of which field or value was
// rejected — which is exactly why the Root Cause 3-7 enum mismatches
// looked like unexplained data loss rather than a validation error the
// person could have acted on. errorMessage() now pulls the first
// per-field message out of Zod's flatten() shape when present.

describe("errorMessage — plain errors (no validation details)", () => {
  it("returns the message for a plain Error", () => {
    expect(errorMessage(new Error("network failure"))).toBe("network failure");
  });

  it("returns a generic fallback for a non-error value", () => {
    expect(errorMessage("just a string")).toBe("Something went wrong.");
    expect(errorMessage(null)).toBe("Something went wrong.");
    expect(errorMessage(undefined)).toBe("Something went wrong.");
  });

  it("returns the base message unchanged when details is absent", () => {
    expect(errorMessage({ message: "invalid_request" })).toBe("invalid_request");
  });
});

describe("errorMessage — with Zod flatten() validation details", () => {
  it("appends the first field-level message when details.fieldErrors is present", () => {
    const err = {
      message: "invalid_request",
      details: {
        formErrors: [],
        fieldErrors: {
          status: ["Invalid enum value. Expected 'us_citizen' | 'permanent_resident' | ..."],
        },
      },
    };
    expect(errorMessage(err)).toBe(
      "invalid_request — status: Invalid enum value. Expected 'us_citizen' | 'permanent_resident' | ...",
    );
  });

  it("joins multiple field errors with a semicolon", () => {
    const err = {
      message: "invalid_request",
      details: {
        formErrors: [],
        fieldErrors: {
          status: ["Invalid enum value"],
          citizenship_country: ["Required"],
        },
      },
    };
    const result = errorMessage(err);
    expect(result).toContain("status: Invalid enum value");
    expect(result).toContain("citizenship_country: Required");
  });

  it("falls back to the base message when fieldErrors is empty", () => {
    const err = { message: "invalid_request", details: { formErrors: [], fieldErrors: {} } };
    expect(errorMessage(err)).toBe("invalid_request");
  });

  it("never throws on a malformed/unexpected details shape", () => {
    expect(errorMessage({ message: "x", details: null })).toBe("x");
    expect(errorMessage({ message: "x", details: "not an object" })).toBe("x");
    expect(errorMessage({ message: "x", details: 42 })).toBe("x");
    expect(errorMessage({ message: "x", details: { fieldErrors: "not an object" } })).toBe("x");
    expect(errorMessage({ message: "x", details: { fieldErrors: { a: "not an array" } } })).toBe("x");
  });
});

// relativeTimeAgo — powers the "Catalog refreshed Xh ago" freshness
// signal on the Today page (see pages/today.ts), sourced from
// opportunity_source.last_seen_at via GET /today's feed_summary. Frozen
// "now" via fake timers so these assertions are deterministic rather than
// depending on wall-clock time when the suite happens to run.
describe("relativeTimeAgo", () => {
  const NOW = new Date("2026-08-29T12:00:00Z");

  it("returns 'never' for null/undefined — ingestion has not produced any visible data yet", () => {
    expect(relativeTimeAgo(null)).toBe("never");
    expect(relativeTimeAgo(undefined)).toBe("never");
  });

  it("returns 'unknown' for an unparseable date string rather than throwing or showing 'NaN ago'", () => {
    expect(relativeTimeAgo("not-a-date")).toBe("unknown");
  });

  it("formats minutes, hours, and days ago correctly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      expect(relativeTimeAgo("2026-08-29T11:59:30Z")).toBe("just now"); // 30s ago
      expect(relativeTimeAgo("2026-08-29T11:45:00Z")).toBe("15m ago");
      expect(relativeTimeAgo("2026-08-29T09:00:00Z")).toBe("3h ago");
      expect(relativeTimeAgo("2026-08-26T12:00:00Z")).toBe("3d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a timestamp slightly in the future (clock skew) as 'just now', not a negative age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      expect(relativeTimeAgo("2026-08-29T12:00:05Z")).toBe("just now");
    } finally {
      vi.useRealTimers();
    }
  });
});
