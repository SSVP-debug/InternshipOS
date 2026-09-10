import { describe, it, expect } from "vitest";
import { isWellFormedUrl, coerceToWellFormedUrl } from "../src/lib/ingestion/urlValidation.js";

describe("isWellFormedUrl", () => {
  it("returns true for a well-formed https URL", () => {
    expect(isWellFormedUrl("https://example.com/job/123")).toBe(true);
  });

  it("returns true for a well-formed http URL", () => {
    expect(isWellFormedUrl("http://example.com/job/123")).toBe(true);
  });

  it("returns false for a non-http(s) scheme (e.g. ftp)", () => {
    expect(isWellFormedUrl("ftp://example.com/file")).toBe(false);
  });

  it("returns false for a string that isn't a URL at all", () => {
    expect(isWellFormedUrl("not-a-url")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isWellFormedUrl("")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isWellFormedUrl(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isWellFormedUrl(undefined)).toBe(false);
  });

  it("returns false for a scheme-relative/protocol-relative fragment", () => {
    expect(isWellFormedUrl("//example.com/job/123")).toBe(false);
  });

  it("returns false for a bare domain with no scheme", () => {
    expect(isWellFormedUrl("example.com/job/123")).toBe(false);
  });
});

describe("coerceToWellFormedUrl", () => {
  it("returns a well-formed URL unchanged", () => {
    expect(coerceToWellFormedUrl("https://example.com/apply/1")).toBe("https://example.com/apply/1");
  });

  it("returns null for a malformed URL", () => {
    expect(coerceToWellFormedUrl("not-a-url")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(coerceToWellFormedUrl(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(coerceToWellFormedUrl(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(coerceToWellFormedUrl("")).toBeNull();
  });
});
