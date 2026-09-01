import { describe, it, expect, vi } from "vitest";
import {
  runMatchingForActiveCandidates,
  RunMatchingCandidateListError,
} from "../src/lib/matching/runMatchingForActiveCandidates.js";

const CANDIDATE_A = "11111111-1111-1111-1111-111111111111";
const CANDIDATE_B = "22222222-2222-2222-2222-222222222222";
const CANDIDATE_C = "33333333-3333-3333-3333-333333333333";
const RESUME_A1 = "66666666-6666-6666-6666-666666666666";
const RESUME_A2 = "77777777-7777-7777-7777-777777777777";

const UNENRICHED_OPPORTUNITY_ROW = {
  id: "44444444-4444-4444-4444-444444444444",
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
 * Mocks the subset of the Supabase query builder used by both
 * loadAllCandidateIds/loadActiveResumeIdsForCandidate (this module) and
 * runMatchingForCandidate.ts (skill/resume_skill/education/experience/
 * project/work_authorization/opportunity_source, plus the Gate R2
 * batch-upsert RPC). `candidateBehavior` lets a test make matching fail
 * for one specific candidate id, either by throwing (simulating a read
 * error) or by making the batch-upsert RPC fail for that candidate only.
 *
 * Gate R2 changed the write path from `.from("opportunity_match")
 * .upsert(...)` to `.rpc("upsert_opportunity_match_batch", ...)` — this
 * mock's `rpc` replaces the old `opportunity_match` branch entirely.
 * `resumeIdsByCandidate` (default: no candidate has any resumes) drives
 * how many resume-scoped passes each candidate gets.
 */
function mockSupabase(options: {
  candidateIds?: string[];
  candidateListError?: { message: string } | null;
  failReadForCandidate?: string;
  failUpsertForCandidate?: string;
  resumeIdsByCandidate?: Record<string, string[]>;
} = {}) {
  const candidateIds = options.candidateIds ?? [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C];

  // runMatchingForCandidate.ts's internal queries are all scoped with
  // .eq("candidate_id", <id>) except opportunity_source's
  // .eq("status","active") and resume_skill's .eq("resume_id", <id>) —
  // track the "current" candidate_id being queried per call chain so
  // failReadForCandidate/failUpsertForCandidate can target one candidate
  // without affecting the others.
  let currentCandidateId: string | null = null;
  const inCalls: { column: string; values: readonly string[] }[] = [];

  const rpc = vi.fn(async (_fn: string, _args: unknown) => {
    if (currentCandidateId === options.failUpsertForCandidate) {
      return { data: null, error: { message: `upsert failed for ${currentCandidateId}` } };
    }
    return { data: null, error: null };
  });

  const from = vi.fn((table: string) => {
    if (table === "candidate") {
      return {
        select: vi.fn(() => ({
          in: vi.fn((column: string, values: readonly string[]) => {
            inCalls.push({ column, values });
            if (options.candidateListError) {
              return Promise.resolve({ data: null, error: options.candidateListError });
            }
            return Promise.resolve({ data: candidateIds.map((id) => ({ id })), error: null });
          }),
        })),
      };
    }

    if (table === "resume") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(async (col: string, val: string) => {
            if (col === "candidate_id") currentCandidateId = val;
            const ids = options.resumeIdsByCandidate?.[val] ?? [];
            return { data: ids.map((id) => ({ id, is_active: true })), error: null };
          }),
        })),
      };
    }

    // opportunity_source is queried with .eq("status","active") once per
    // pass, independent of candidate_id — give it one active opportunity
    // so every pass actually evaluates something.
    if (table === "opportunity_source") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(async (_col: string, _val: string) => ({
            data: [UNENRICHED_OPPORTUNITY_ROW],
            error: null,
          })),
        })),
      };
    }

    // skill / resume_skill / education / experience / project / work_authorization
    return {
      select: vi.fn(() => ({
        eq: vi.fn((col: string, val: string) => {
          if (col === "candidate_id") currentCandidateId = val;

          if (col === "candidate_id" && val === options.failReadForCandidate && table === "skill") {
            return Promise.resolve({ data: null, error: { message: `read failed for ${val}` } });
          }

          const defaultResult =
            table === "work_authorization" ? { data: null, error: null } : { data: [], error: null };

          if (table === "work_authorization") {
            return { maybeSingle: vi.fn(async () => defaultResult) };
          }
          return Promise.resolve(defaultResult);
        }),
      })),
    };
  });

  return { from, rpc, __inCalls: inCalls } as any;
}

describe("runMatchingForActiveCandidates", () => {
  it("loads every candidate id from public.candidate and matches each one (candidate-level pass)", async () => {
    const supabase = mockSupabase();
    const summary = await runMatchingForActiveCandidates(supabase);

    expect(summary.candidatesConsidered).toBe(3);
    expect(summary.candidatesSucceeded).toBe(3);
    expect(summary.candidatesFailed).toBe(0);
    expect(summary.resumePassesConsidered).toBe(0);
    expect(summary.perCandidate.map((c) => c.candidateId).sort()).toEqual(
      [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C].sort()
    );
    // No resumes configured for anyone in this test -> every entry is the candidate-level pass.
    expect(summary.perCandidate.every((c) => c.resumeId === null)).toBe(true);
  });

  it("filters the candidate query to profile_status in ('incomplete','active') — pausing/archiving opts a candidate out of the daily batch", async () => {
    const supabase = mockSupabase();
    await runMatchingForActiveCandidates(supabase);

    expect(supabase.__inCalls).toEqual([{ column: "profile_status", values: ["incomplete", "active"] }]);
  });

  it("aggregates opportunitiesEvaluated, insertedOrUpdated, and eligibilityCounts across all candidates", async () => {
    const supabase = mockSupabase();
    const summary = await runMatchingForActiveCandidates(supabase);

    // One active opportunity per candidate-level pass, no eligibility
    // signals stated anywhere -> each resolves to "unknown", matching
    // matchEngine.ts's documented "never guess" rule.
    expect(summary.totalOpportunitiesEvaluated).toBe(3);
    expect(summary.totalInsertedOrUpdated).toBe(3);
    expect(summary.eligibilityCounts).toEqual({ eligible: 0, ineligible: 0, unknown: 3 });
  });

  it("Gate R2: a candidate with two active resumes gets one candidate-level pass plus two resume-scoped passes", async () => {
    const supabase = mockSupabase({
      candidateIds: [CANDIDATE_A],
      resumeIdsByCandidate: { [CANDIDATE_A]: [RESUME_A1, RESUME_A2] },
    });

    const summary = await runMatchingForActiveCandidates(supabase);

    expect(summary.candidatesConsidered).toBe(1);
    expect(summary.candidatesSucceeded).toBe(1); // candidate-level pass only
    expect(summary.resumePassesConsidered).toBe(2);
    expect(summary.resumePassesSucceeded).toBe(2);
    expect(summary.resumePassesFailed).toBe(0);

    const resumeIdsSeen = summary.perCandidate.map((c) => c.resumeId).sort();
    expect(resumeIdsSeen).toEqual([RESUME_A1, RESUME_A2, null].sort());

    // 3 passes total (1 candidate-level + 2 resume) x 1 opportunity each.
    expect(summary.totalOpportunitiesEvaluated).toBe(3);
    expect(summary.totalInsertedOrUpdated).toBe(3);
  });

  it("Gate R2: candidates with no resumes get zero resume passes — purely additive, not required", async () => {
    const supabase = mockSupabase({ resumeIdsByCandidate: {} });
    const summary = await runMatchingForActiveCandidates(supabase);

    expect(summary.resumePassesConsidered).toBe(0);
    expect(summary.resumePassesSucceeded).toBe(0);
    expect(summary.resumePassesFailed).toBe(0);
  });

  it("one candidate's read failure is recorded as a failure and does not stop the others", async () => {
    const supabase = mockSupabase({ failReadForCandidate: CANDIDATE_B });
    const summary = await runMatchingForActiveCandidates(supabase);

    expect(summary.candidatesConsidered).toBe(3);
    expect(summary.candidatesSucceeded).toBe(2);
    expect(summary.candidatesFailed).toBe(1);
    expect(summary.failures).toEqual([
      { candidateId: CANDIDATE_B, resumeId: null, message: expect.stringContaining("read failed") },
    ]);
    // the other two candidates still succeeded
    expect(summary.perCandidate.map((c) => c.candidateId).sort()).toEqual([CANDIDATE_A, CANDIDATE_C].sort());
  });

  it("a candidate whose batch-upsert RPC fails is reported as a failure, not counted as succeeded", async () => {
    const supabase = mockSupabase({ failUpsertForCandidate: CANDIDATE_A });
    const summary = await runMatchingForActiveCandidates(supabase);

    expect(summary.candidatesSucceeded).toBe(2);
    expect(summary.candidatesFailed).toBe(1);
    expect(summary.failures[0].candidateId).toBe(CANDIDATE_A);
    expect(summary.failures[0].message).toMatch(/upsert failed/);
  });

  it("loading the candidate list itself is fatal — throws RunMatchingCandidateListError, nothing to iterate safely", async () => {
    const supabase = mockSupabase({ candidateListError: { message: "connection reset" } });

    await expect(runMatchingForActiveCandidates(supabase)).rejects.toThrow(RunMatchingCandidateListError);
    await expect(runMatchingForActiveCandidates(supabase)).rejects.toThrow(/connection reset/);
  });

  it("zero candidates -> a zeroed summary, no crash, no RPC call attempted", async () => {
    const supabase = mockSupabase({ candidateIds: [] });
    const summary = await runMatchingForActiveCandidates(supabase);

    expect(summary.candidatesConsidered).toBe(0);
    expect(summary.candidatesSucceeded).toBe(0);
    expect(summary.candidatesFailed).toBe(0);
    expect(summary.resumePassesConsidered).toBe(0);
    expect(summary.totalOpportunitiesEvaluated).toBe(0);
    expect(summary.perCandidate).toEqual([]);
    expect(summary.failures).toEqual([]);
  });

  it("is idempotent: running twice in a row against the same mock produces the same aggregate result", async () => {
    const supabase = mockSupabase();
    const first = await runMatchingForActiveCandidates(supabase);
    const second = await runMatchingForActiveCandidates(supabase);

    expect(second.candidatesSucceeded).toBe(first.candidatesSucceeded);
    expect(second.totalOpportunitiesEvaluated).toBe(first.totalOpportunitiesEvaluated);
    expect(second.totalInsertedOrUpdated).toBe(first.totalInsertedOrUpdated);
  });
});
