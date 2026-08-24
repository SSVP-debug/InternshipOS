import { describe, it, expect } from "vitest";
import { computeDedupFingerprint } from "../src/lib/ingestion/dedupFingerprint.js";

describe("computeDedupFingerprint", () => {
  it("is deterministic for the same source name + ref", () => {
    const a = computeDedupFingerprint("remoteok", "1010101");
    const b = computeDedupFingerprint("remoteok", "1010101");
    expect(a).toBe(b);
  });

  it("produces a 64-char lowercase hex sha256 digest", () => {
    const fingerprint = computeDedupFingerprint("adzuna", "4455667788");
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("differs when source_ref differs", () => {
    const a = computeDedupFingerprint("remoteok", "1010101");
    const b = computeDedupFingerprint("remoteok", "1010102");
    expect(a).not.toBe(b);
  });

  it("differs when source name differs, even with the same ref (no cross-source collision)", () => {
    const a = computeDedupFingerprint("remoteok", "1010101");
    const b = computeDedupFingerprint("adzuna", "1010101");
    expect(a).not.toBe(b);
  });

  it("is case-insensitive on source name and trims whitespace on both inputs", () => {
    const a = computeDedupFingerprint("RemoteOK", "1010101");
    const b = computeDedupFingerprint("  remoteok  ", "  1010101  ");
    expect(a).toBe(b);
  });
});
