// runMatchingForActiveCandidates.ts
// P0 automation phase — batch wrapper around the existing, UNMODIFIED
// runMatchingForCandidate.ts. This module adds no scoring/eligibility/
// matching logic of its own; it only decides WHICH candidates to run
// runMatchingForCandidate for, and isolates one candidate's failure from
// the rest of the batch. matchEngine.ts, runMatchingForCandidate.ts, and
// the pure mappers are untouched — see their own files.
//
// "ACTIVE CANDIDATES" — DECISION, NOT AN ASSUMPTION:
// public.candidate.profile_status ('incomplete'/'active'/'paused'/
// 'archived') is set to 'incomplete' exactly once, by
// handle_new_auth_user() (0006_signup_provisioning.sql), and is never
// written anywhere else in this codebase — no route or script ever
// transitions it. Filtering on profile_status = 'active' would therefore
// match zero candidates today, silently turning this into a no-op. This
// module deliberately does NOT do that. Instead, per the P0 audit's
// documented recommendation, "active" is defined as "every row in
// public.candidate" — matching runMatchingForCandidate.ts's own existing
// tolerance for sparse/missing candidate data (empty skills/education/
// experience/projects and a null work_authorization all resolve to
// eligibility 'unknown' rather than an error; see matchEngine.ts). A
// candidate who has only just signed up is matched with zero signal and
// gets an honest "unknown" feed entry, not skipped. Redefining/wiring
// profile_status into a real lifecycle is a separate, later decision —
// this module does not attempt it, and does not read or filter on
// profile_status at all, so that decision remains fully open.
//
// CALLER IS SERVICE-ROLE: same posture as runMatchingForCandidate.ts —
// written for an operator/scheduler-triggered, cross-candidate
// operation (api/scripts/match-all.ts), not a request-serving path.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runMatchingForCandidate,
  RunMatchingReadError,
  type EligibilityCounts,
  type RunMatchingSummary,
} from "./runMatchingForCandidate.js";

const CANDIDATE_ID_COLUMN = "id";

export interface CandidateMatchOutcome {
  candidateId: string;
  opportunitiesEvaluated: number;
  insertedOrUpdated: number;
  eligibilityCounts: EligibilityCounts;
  errors: string[];
}

export interface CandidateMatchFailure {
  candidateId: string;
  message: string;
}

export interface RunMatchingForActiveCandidatesSummary {
  candidatesConsidered: number;
  candidatesSucceeded: number;
  candidatesFailed: number;
  totalOpportunitiesEvaluated: number;
  totalInsertedOrUpdated: number;
  eligibilityCounts: EligibilityCounts;
  perCandidate: CandidateMatchOutcome[];
  failures: CandidateMatchFailure[];
}

/**
 * Thrown when the candidate list itself cannot be loaded — this is
 * unambiguously fatal (there is nothing to iterate safely), unlike a
 * single candidate's matching failure below, which is caught and
 * reported instead of thrown. Mirrors RunMatchingReadError's own
 * "prerequisite read failure" semantics in runMatchingForCandidate.ts.
 */
export class RunMatchingCandidateListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunMatchingCandidateListError";
  }
}

async function loadAllCandidateIds(supabase: Pick<SupabaseClient, "from">): Promise<string[]> {
  const { data, error } = await supabase.from("candidate").select(CANDIDATE_ID_COLUMN);

  if (error) {
    throw new RunMatchingCandidateListError(`Failed to load candidate list: ${error.message}`);
  }

  return ((data ?? []) as unknown as Array<{ id: string }>).map((row) => row.id);
}

function emptyEligibilityCounts(): EligibilityCounts {
  return { eligible: 0, ineligible: 0, unknown: 0 };
}

function addEligibilityCounts(target: EligibilityCounts, addend: EligibilityCounts): void {
  target.eligible += addend.eligible;
  target.ineligible += addend.ineligible;
  target.unknown += addend.unknown;
}

/**
 * Runs runMatchingForCandidate for every candidate in public.candidate
 * (see the "ACTIVE CANDIDATES" note above). One candidate's failure —
 * whether a thrown RunMatchingReadError (candidate-data or
 * opportunity_source read failure, see runMatchingForCandidate.ts) or
 * any other unexpected rejection — is caught, recorded in `failures`,
 * and does NOT stop the remaining candidates from being matched. Only a
 * failure to load the candidate list itself (nothing to safely iterate)
 * throws, via RunMatchingCandidateListError.
 *
 * Idempotent: this calls the existing, unmodified runMatchingForCandidate
 * for each candidate, which itself upserts on the existing
 * (candidate_id, opportunity_source_id) unique constraint — running this
 * batch twice in a row updates opportunity_match rows, never duplicates
 * them.
 */
export async function runMatchingForActiveCandidates(
  supabase: Pick<SupabaseClient, "from">
): Promise<RunMatchingForActiveCandidatesSummary> {
  const candidateIds = await loadAllCandidateIds(supabase);

  const perCandidate: CandidateMatchOutcome[] = [];
  const failures: CandidateMatchFailure[] = [];
  const eligibilityCounts = emptyEligibilityCounts();
  let totalOpportunitiesEvaluated = 0;
  let totalInsertedOrUpdated = 0;

  for (const candidateId of candidateIds) {
    let result: RunMatchingSummary;
    try {
      result = await runMatchingForCandidate(supabase, candidateId);
    } catch (error) {
      // A single candidate's read failure (RunMatchingReadError) or any
      // other unexpected error must not abort the batch — recorded here,
      // never silently dropped and never allowed to escape this loop.
      const message =
        error instanceof RunMatchingReadError || error instanceof Error ? error.message : String(error);
      failures.push({ candidateId, message });
      continue;
    }

    // runMatchingForCandidate itself never throws for a failed
    // opportunity_match upsert — it reports that failure in
    // result.errors instead (see its own tests). Surface that here too,
    // as a failure entry, rather than counting a candidate as
    // "succeeded" when their matches were never actually persisted.
    if (result.errors.length > 0) {
      failures.push({ candidateId, message: result.errors.join("; ") });
      continue;
    }

    perCandidate.push({
      candidateId,
      opportunitiesEvaluated: result.opportunitiesEvaluated,
      insertedOrUpdated: result.insertedOrUpdated,
      eligibilityCounts: result.eligibilityCounts,
      errors: result.errors,
    });
    totalOpportunitiesEvaluated += result.opportunitiesEvaluated;
    totalInsertedOrUpdated += result.insertedOrUpdated;
    addEligibilityCounts(eligibilityCounts, result.eligibilityCounts);
  }

  return {
    candidatesConsidered: candidateIds.length,
    candidatesSucceeded: perCandidate.length,
    candidatesFailed: failures.length,
    totalOpportunitiesEvaluated,
    totalInsertedOrUpdated,
    eligibilityCounts,
    perCandidate,
    failures,
  };
}
