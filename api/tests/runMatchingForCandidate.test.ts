import { describe, it, expect, vi } from "vitest";
import { runMatchingForCandidate, RunMatchingReadError } from "../src/lib/matching/runMatchingForCandidate.js";
import { buildCandidateMatchInput } from "../src/lib/matching/buildCandidateMatchInput.js";
import { buildOpportunityMatchInput } from "../src/lib/matching/buildOpportunityMatchInput.js";
import { matchCandidate } from "../src/lib/matchEngine.js";

const CANDIDATE_ID = "11111111-1111-1111-1111-111111111111";
const RESUME_ID = "55555555-5555-5555-5555-555555555555";

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
 * orchestrator uses. Configurable per table via `tableResults`, for the
 * Gate R2 batch-upsert RPC via `rpcError`, and for resume-scoped skill
 * loading via `resumeSkillNames` (the resume_skill -> skill embed).
 *
 * Gate R2 changed the write path from `.from("opportunity_match")
 * .upsert(...)` to `.rpc("upsert_opportunity_match_batch", ...)` — see
 * runMatchingForCandidate.ts's own comments for why a plain client-side
 * upsert can no longer target opportunity_match's two partial unique
 * indexes. This mock reflects that: opportunity_match no longer needs
 * its own `from()` branch at all, and `rpcMock` replaces `upsertMock`.
 */
function mockSupabase(options: {
  tableResults?: Record<string, { data: unknown; error: { message: string } | null }>;
  rpcError?: { message: string } | null;
  resumeSkillNames?: string[];
} = {}) {
  const eqSpy = vi.fn();
  const rpcMock = vi.fn(async (_fn: string, _args: unknown) => ({
    data: null,
    error: options.rpcError ?? null,
  }));

  const from = vi.fn((table: string) => {
    if (table === "resume_skill") {
      return {
        select: vi.fn((_cols: string) => ({
          eq: vi.fn((col: string, val: string) => {
            eqSpy(table, col, val);
            if (options.tableResults?.[table]) {
              return Promise.resolve(options.tableResults[table]);
            }
            const names = options.resumeSkillNames ?? [];
            return Promise.resolve({ data: names.map((name) => ({ skill: { name } })), error: null });
          }),
        })),
      };
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

  return { from, rpc: rpcMock, rpcMock, eqSpy } as any;
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

  it("calls matchCandidate and writes score/eligibility/breakdown via the batch-upsert RPC", async () => {
    const supabase = mockSupabase({
      tableResults: {
        skill: { data: [{ name: "python" }], error: null },
        opportunity_source: { data: [UNENRICHED_OPPORTUNITY_ROW], error: null },
      },
    });

    const summary = await runMatchingForCandidate(supabase, CANDIDATE_ID);

    expect(summary.opportunitiesEvaluated).toBe(1);
    expect(summary.insertedOrUpdated).toBe(1);
    expect(summary.resumeId).toBeNull();
    expect(supabase.rpcMock).toHaveBeenCalledTimes(1);

    const [fnName, args] = supabase.rpcMock.mock.calls[0];
    expect(fnName).toBe("upsert_opportunity_match_batch");
    const rows = args.p_rows;
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.candidate_id).toBe(CANDIDATE_ID);
    expect(row.opportunity_source_id).toBe(UNENRICHED_OPPORTUNITY_ROW.id);
    expect(row.resume_id).toBeNull();

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
  });

  it("Gate R2: with a resumeId, loads skills via resume_skill instead of the candidate's full skill table", async () => {
    const supabase = mockSupabase({
      tableResults: { opportunity_source: { data: [UNENRICHED_OPPORTUNITY_ROW], error: null } },
      resumeSkillNames: ["python"],
    });

    const summary = await runMatchingForCandidate(supabase, CANDIDATE_ID, RESUME_ID);

    expect(summary.resumeId).toBe(RESUME_ID);

    const tablesQueried = supabase.from.mock.calls.map((call: unknown[]) => call[0]);
    expect(tablesQueried).not.toContain("skill");
    expect(tablesQueried).toContain("resume_skill");
    expect(supabase.eqSpy).toHaveBeenCalledWith("resume_skill", "resume_id", RESUME_ID);

    const [, args] = supabase.rpcMock.mock.calls[0];
    const row = args.p_rows[0];
    expect(row.resume_id).toBe(RESUME_ID);
    // Same skill ("python") as the candidate-level test above, loaded
    // through resume_skill this time — score/eligibility should match.
    expect(row.eligibility_status).toBeDefined();
  });

  it("Gate R2: a resume with no linked skills produces an empty skill list, not an error", async () => {
    const supabase = mockSupabase({
      tableResults: { opportunity_source: { data: [UNENRICHED_OPPORTUNITY_ROW], error: null } },
      resumeSkillNames: [],
    });

    const summary = await runMatchingForCandidate(supabase, CANDIDATE_ID, RESUME_ID);
    expect(summary.errors).toHaveLength(0);
    expect(summary.eligibilityCounts.unknown).toBe(1); // no skills stated -> unknown, never guessed
  });

  it("an opportunity with every 0023 eligibility column NULL results in eligibility_status = 'unknown' — never guessed", async () => {
    const supabase = mockSupabase({
      tableResults: {
        opportunity_source: { data: [UNENRICHED_OPPORTUNITY_ROW], error: null },
      },
    });

    const summary = await runMatchingForCandidate(supabase, CANDIDATE_ID);
    const [, args] = supabase.rpcMock.mock.calls[0];

    expect(args.p_rows[0].eligibility_status).toBe("unknown");
    expect(summary.eligibilityCounts).toEqual({ eligible: 0, ineligible: 0, unknown: 1 });
  });

  it("rerunning calls the batch-upsert RPC again — idempotent by design (see the SQL function's ON CONFLICT branches)", async () => {
    const supabase = mockSupabase({
      tableResults: { opportunity_source: { data: [UNENRICHED_OPPORTUNITY_ROW], error: null } },
    });

    await runMatchingForCandidate(supabase, CANDIDATE_ID);
    await runMatchingForCandidate(supabase, CANDIDATE_ID);

    expect(supabase.rpcMock).toHaveBeenCalledTimes(2);
    for (const call of supabase.rpcMock.mock.calls) {
      expect(call[0]).toBe("upsert_opportunity_match_batch");
    }
  });

  it("surfaces a candidate-data read failure by throwing, rather than returning a misleading empty summary", async () => {
    const supabase = mockSupabase({
      tableResults: { skill: { data: null, error: { message: "connection reset" } } },
    });

    await expect(runMatchingForCandidate(supabase, CANDIDATE_ID)).rejects.toThrow(RunMatchingReadError);
    await expect(runMatchingForCandidate(supabase, CANDIDATE_ID)).rejects.toThrow(/connection reset/);
  });

  it("Gate R2: surfaces a resume_skill read failure by throwing, same as any other prerequisite read", async () => {
    const supabase = mockSupabase({
      tableResults: { resume_skill: { data: null, error: { message: "connection reset" } } },
    });

    await expect(runMatchingForCandidate(supabase, CANDIDATE_ID, RESUME_ID)).rejects.toThrow(RunMatchingReadError);
  });

  it("surfaces an opportunity_source read failure by throwing", async () => {
    const supabase = mockSupabase({
      tableResults: { opportunity_source: { data: null, error: { message: "timeout" } } },
    });

    await expect(runMatchingForCandidate(supabase, CANDIDATE_ID)).rejects.toThrow(RunMatchingReadError);
  });

  it("surfaces a batch-upsert RPC failure in the summary's errors, not silently", async () => {
    const supabase = mockSupabase({
      tableResults: { opportunity_source: { data: [UNENRICHED_OPPORTUNITY_ROW], error: null } },
      rpcError: { message: "unique constraint violation" },
    });

    const summary = await runMatchingForCandidate(supabase, CANDIDATE_ID);

    expect(summary.insertedOrUpdated).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatch(/unique constraint violation/);
  });

  it("returns a zeroed summary and makes no RPC call when there are no active opportunities", async () => {
    const supabase = mockSupabase({ tableResults: { opportunity_source: { data: [], error: null } } });
    const summary = await runMatchingForCandidate(supabase, CANDIDATE_ID);

    expect(summary.opportunitiesEvaluated).toBe(0);
    expect(summary.insertedOrUpdated).toBe(0);
    expect(supabase.rpcMock).not.toHaveBeenCalled();
  });
});
