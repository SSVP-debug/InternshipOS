import { describe, it, expect, vi } from "vitest";
import { runMatchingForCandidate, RunMatchingReadError } from "../src/lib/matching/runMatchingForCandidate.js";
import { buildCandidateMatchInput } from "../src/lib/matching/buildCandidateMatchInput.js";
import { buildOpportunityMatchInput } from "../src/lib/matching/buildOpportunityMatchInput.js";
import { matchCandidate } from "../src/lib/matchEngine.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";

/** The exact shape returned by a real ingested-but-unenriched opportunity_source row (see Phase 2 inspection, finding G). */
const UNENRICHED_OPPORTUNITY_ROW = {
  id: "22222222-2222-2222-2222-222222222222",
  employment_type: "internship" as const,
  skills: ["python"],
  sponsorship_offered: null,
  citizenship_requirement: null,
  deadline_date: null,
  jurisdiction_country: null,
  eligible_candidate_countries: null,
  citizenship_required_countries: null,
  requires_existing_work_authorization: null,
  required_degree_types: null,
  required_majors: null,
  required_major_match_mode: null,
  graduation_not_before: null,
  graduation_not_after: null,
  required_enrollment_statuses: null,
};

/**
 * Minimal mock of the subset of the Supabase query builder this
 * orchestrator uses. Configurable per table via `tableResults`, and for
 * opportunity_match's upsert via `upsertError`. No live network or
 * Supabase calls — same style as writeOpportunitySource.test.ts.
 */
function mockSupabase(options: {
  tableResults?: Record<string, { data: unknown; error: { message: string } | null }>;
  upsertError?: { message: string } | null;
} = {}) {
  const eqSpy = vi.fn();
  const upsertMock = vi.fn(async (_rows: unknown[], _opts: unknown) => ({
    data: null,
    error: options.upsertError ?? null,
  }));

  const from = vi.fn((table: string) => {
    if (table === "opportunity_match") {
      return { upsert: upsertMock };
    }

    // Real Supabase .maybeSingle() returns { data: null, error: null }
    // when zero rows match — a different shape than the array default for
    // list-returning tables. Getting this wrong here (e.g. defaulting to
    // `[]`) would silently turn "no work_authorization row" into a
    // truthy-but-empty array, which is exactly the kind of defaulting
    // buildCandidateMatchInput.ts is designed to refuse — so the mock
    // must not introduce it either.
    const defaultResult = table === "work_authorization" ? { data: null, error: null } : { data: [], error: null };
    const result = options.tableResults?.[table] ?? defaultResult;

    return {
      select: vi.fn((_cols: string) => ({
        eq: vi.fn((col: string, val: string) => {
          eqSpy(table, col, val);
          if (table === "work_authorization") {
            return { maybeSingle: vi.fn(async () => result) };
          }
          return Promise.resolve(result);
        }),
      })),
    };
  });

  return { from, upsertMock, eqSpy } as any;
}

describe("runMatchingForCandidate", () => {
  it("loads candidate data from all five candidate-owned tables", async () => {
    const supabase = mockSupabase();
    await runMatchingForCandidate(supabase, CANDIDATE_ID);

    const tablesQueried = supabase.from.mock.calls.map((call: unknown[]) => call[0]);
    expect(tablesQueried).toEqual(
      expect.arrayContaining(["skill", "education", "experience", "project", "work_authorization"])
    );
  });

  it("loads only active opportunities (filters opportunity_source on status = 'active')", async () => {
    const supabase = mockSupabase();
    await runMatchingForCandidate(supabase, CANDIDATE_ID);

    expect(supabase.eqSpy).toHaveBeenCalledWith("opportunity_source", "status", "active");
  });

  it("calls matchCandidate and writes score/eligibility/breakdown into opportunity_match", async () => {
    const supabase = mockSupabase({
      tableResults: {
        skill: { data: [{ name: "python" }], error: null },
        opportunity_source: { data: [UNENRICHED_OPPORTUNITY_ROW], error: null },
      },
    });

    const summary = await runMatchingForCandidate(supabase, CANDIDATE_ID);

    expect(summary.opportunitiesEvaluated).toBe(1);
    expect(summary.insertedOrUpdated).toBe(1);
    expect(supabase.upsertMock).toHaveBeenCalledTimes(1);

    const [rows, opts] = supabase.upsertMock.mock.calls[0];
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.candidate_id).toBe(CANDIDATE_ID);
    expect(row.opportunity_source_id).toBe(UNENRICHED_OPPORTUNITY_ROW.id);

    // Cross-check against a direct call to the real, unmodified matchCandidate.
    const expected = matchCandidate(
      buildCandidateMatchInput({
        skills: [{ name: "python" }],
        education: [],
        experience: [],
        projects: [],
        workAuthorization: null,
      }),
      buildOpportunityMatchInput(UNENRICHED_OPPORTUNITY_ROW)
    );

    expect(row.match_score).toBe(expected.score);
    expect(row.eligibility_status).toBe(expected.eligibility);
    expect(row.match_breakdown).toEqual({
      breakdown: expected.breakdown,
      reasons: expected.reasons,
      missing: expected.missing,
      unknown: expected.unknown,
    });

    // Upsert is scoped to the existing unique constraint, so a re-run
    // updates rather than duplicates.
    expect(opts).toEqual({ onConflict: "candidate_id,opportunity_source_id" });
  });

  it("an opportunity with every 0023 eligibility column NULL results in eligibility_status = 'unknown' — never guessed", async () => {
    const supabase = mockSupabase({
      tableResults: {
        opportunity_source: { data: [UNENRICHED_OPPORTUNITY_ROW], error: null },
      },
    });

    const summary = await runMatchingForCandidate(supabase, CANDIDATE_ID);
    const [rows] = supabase.upsertMock.mock.calls[0];

    expect(rows[0].eligibility_status).toBe("unknown");
    expect(summary.eligibilityCounts).toEqual({ eligible: 0, ineligible: 0, unknown: 1 });
  });

  it("rerunning is an upsert (onConflict on the existing unique constraint), not an insert-only call", async () => {
    const supabase = mockSupabase({
      tableResults: { opportunity_source: { data: [UNENRICHED_OPPORTUNITY_ROW], error: null } },
    });

    await runMatchingForCandidate(supabase, CANDIDATE_ID);
    await runMatchingForCandidate(supabase, CANDIDATE_ID);

    expect(supabase.upsertMock).toHaveBeenCalledTimes(2);
    for (const call of supabase.upsertMock.mock.calls) {
      expect(call[1]).toEqual({ onConflict: "candidate_id,opportunity_source_id" });
    }
  });

  it("surfaces a candidate-data read failure by throwing, rather than returning a misleading empty summary", async () => {
    const supabase = mockSupabase({
      tableResults: { skill: { data: null, error: { message: "connection reset" } } },
    });

    await expect(runMatchingForCandidate(supabase, CANDIDATE_ID)).rejects.toThrow(RunMatchingReadError);
    await expect(runMatchingForCandidate(supabase, CANDIDATE_ID)).rejects.toThrow(/connection reset/);
  });

  it("surfaces an opportunity_source read failure by throwing", async () => {
    const supabase = mockSupabase({
      tableResults: { opportunity_source: { data: null, error: { message: "timeout" } } },
    });

    await expect(runMatchingForCandidate(supabase, CANDIDATE_ID)).rejects.toThrow(RunMatchingReadError);
  });

  it("surfaces an opportunity_match write failure in the summary's errors, not silently", async () => {
    const supabase = mockSupabase({
      tableResults: { opportunity_source: { data: [UNENRICHED_OPPORTUNITY_ROW], error: null } },
      upsertError: { message: "unique constraint violation" },
    });

    const summary = await runMatchingForCandidate(supabase, CANDIDATE_ID);

    expect(summary.insertedOrUpdated).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatch(/unique constraint violation/);
  });

  it("returns a zeroed summary and performs no upsert when there are no active opportunities", async () => {
    const supabase = mockSupabase({ tableResults: { opportunity_source: { data: [], error: null } } });
    const summary = await runMatchingForCandidate(supabase, CANDIDATE_ID);

    expect(summary.opportunitiesEvaluated).toBe(0);
    expect(summary.insertedOrUpdated).toBe(0);
    expect(supabase.upsertMock).not.toHaveBeenCalled();
  });
});
