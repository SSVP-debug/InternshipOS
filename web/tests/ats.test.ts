import { describe, it, expect } from "vitest";
import { isLeverPostingUrl, atsErrorMessage } from "../src/lib/ats.js";

describe("isLeverPostingUrl", () => {
  const POSTING_ID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";

  it("matches a bare hosted Lever posting URL", () => {
    expect(isLeverPostingUrl(`https://jobs.lever.co/acme/${POSTING_ID}`)).toBe(true);
  });

  it("matches a Lever posting URL with a trailing path/query", () => {
    expect(isLeverPostingUrl(`https://jobs.lever.co/acme/${POSTING_ID}/apply?src=feed`)).toBe(true);
  });

  it("rejects a Greenhouse URL", () => {
    expect(isLeverPostingUrl("https://boards.greenhouse.io/acme/jobs/12345")).toBe(false);
  });

  it("rejects a Lever-lookalike URL with an invalid posting id", () => {
    expect(isLeverPostingUrl("https://jobs.lever.co/acme/not-a-uuid")).toBe(false);
  });

  it("rejects null and undefined without throwing", () => {
    expect(isLeverPostingUrl(null)).toBe(false);
    expect(isLeverPostingUrl(undefined)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isLeverPostingUrl("")).toBe(false);
  });
});

describe("atsErrorMessage", () => {
  it("returns the friendly copy for a known error code", () => {
    expect(atsErrorMessage("unsupported_ats")).toContain("only supports Lever-hosted postings");
  });

  it("falls back to the provided server message for an unknown code", () => {
    expect(atsErrorMessage("some_future_error", "Server said this.")).toBe("Server said this.");
  });

  it("falls back to the raw code when neither a mapping nor a fallback message exists", () => {
    expect(atsErrorMessage("some_future_error")).toBe("some_future_error");
  });
});
