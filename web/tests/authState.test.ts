import { describe, it, expect } from "vitest";
import { authStateTransitioned } from "../src/lib/authState.js";

// Gate A1 (persistent navigation) regression coverage. main.ts used to
// force a full route re-render (tearing down and re-fetching the current
// page) on every single Supabase onSessionChange event, including
// same-state events like TOKEN_REFRESHED that fire automatically while a
// tab stays open. authStateTransitioned() is the pure decision extracted
// out of that callback so it's testable without a DOM/browser
// environment (this suite's vitest config is deliberately node-only —
// see vitest.config.ts's own header).

describe("authStateTransitioned", () => {
  it("is false when the session stays authenticated across the event (e.g. a token refresh)", () => {
    expect(authStateTransitioned(true, true)).toBe(false);
  });

  it("is false when the session stays logged out across the event", () => {
    expect(authStateTransitioned(false, false)).toBe(false);
  });

  it("is true on sign-in (logged out -> logged in)", () => {
    expect(authStateTransitioned(false, true)).toBe(true);
  });

  it("is true on sign-out (logged in -> logged out)", () => {
    expect(authStateTransitioned(true, false)).toBe(true);
  });
});
