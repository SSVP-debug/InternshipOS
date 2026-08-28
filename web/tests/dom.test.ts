import { describe, it, expect } from "vitest";
import { errorMessage } from "../src/lib/dom.js";

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
