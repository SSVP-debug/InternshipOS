import { describe, it, expect, vi } from "vitest";
import { requireConsent } from "../src/middleware/requireConsent.js";
import type { AuthedRequest } from "../src/middleware/auth.js";
import type { Response } from "express";

// Test doubles -----------------------------------------------------------
// No HTTP framework or real Supabase client is exercised here -
// requireConsent only ever touches req.supabase, so a minimal chainable
// stub matching the two query shapes it actually calls (candidate lookup,
// consent_record lookup) is enough to test its branching in isolation.
// This mirrors the rest of the suite's "no network dependency" testing
// style (see schemas.test.ts, auth.test.ts).

interface MockScenario {
  candidate?: { id: string } | null;
  candidateError?: { message: string } | null;
  consent?: { id: string } | null;
  consentError?: { message: string } | null;
}

function makeSupabaseMock({
  candidate = { id: "cand-1" },
  candidateError = null,
  consent = null,
  consentError = null,
}: MockScenario) {
  return {
    from(table: string) {
      if (table === "candidate") {
        return {
          select: () => ({
            single: async () => ({ data: candidate, error: candidateError }),
          }),
        };
      }
      if (table === "consent_record") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: () => ({
                  maybeSingle: async () => ({ data: consent, error: consentError }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table in test double: ${table}`);
    },
  };
}

function makeRes() {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as Response["json"];
  return res;
}

describe("requireConsent", () => {
  it("calls next() when the candidate has an active data_processing consent", async () => {
    const req = { supabase: makeSupabaseMock({ consent: { id: "consent-1" } }) } as unknown as AuthedRequest;
    const res = makeRes();
    const next = vi.fn();

    await requireConsent("data_processing")(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 403 consent_required when no consent of that type has ever been granted", async () => {
    const req = { supabase: makeSupabaseMock({ consent: null }) } as unknown as AuthedRequest;
    const res = makeRes();
    const next = vi.fn();

    await requireConsent("data_processing")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toMatchObject({ error: "consent_required", consent_type: "data_processing" });
  });

  it("returns 403 consent_required when the consent was granted but has since been revoked", async () => {
    // A revoked consent never surfaces from the .is("revoked_at", null)
    // query, so from the middleware's perspective this looks identical to
    // "never granted" - which is the correct behavior: revocation must
    // block writes just as effectively as never having consented at all.
    const req = { supabase: makeSupabaseMock({ consent: null }) } as unknown as AuthedRequest;
    const res = makeRes();
    const next = vi.fn();

    await requireConsent("data_processing")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 404 candidate_not_found when the caller has no candidate row", async () => {
    const req = {
      supabase: makeSupabaseMock({ candidate: null, candidateError: { message: "no rows" } }),
    } as unknown as AuthedRequest;
    const res = makeRes();
    const next = vi.fn();

    await requireConsent("data_processing")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toMatchObject({ error: "candidate_not_found" });
  });

  it("returns 400 consent_check_failed when the consent_record query errors", async () => {
    const req = {
      supabase: makeSupabaseMock({ consentError: { message: "connection reset" } }),
    } as unknown as AuthedRequest;
    const res = makeRes();
    const next = vi.fn();

    await requireConsent("data_processing")(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ error: "consent_check_failed" });
  });
});
