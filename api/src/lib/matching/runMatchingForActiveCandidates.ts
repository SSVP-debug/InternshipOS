// runMatchingForActiveCandidates.ts
// P0 automation phase — batch wrapper around the existing, UNMODIFIED
// runMatchingForCandidate.ts. This module adds no scoring/eligibility/
// matching logic of its own; it only decides WHICH candidates to run
// runMatchingForCandidate for, and isolates one candidate's failure from
// the rest of the batch. matchEngine.ts, runMatchingForCandidate.ts, and
// the pure mappers are untouched — see their own files.
//
// "ACTIVE CANDIDATES" — the decision, now made:
// public.candidate.profile_status ('incomplete'/'active'/'paused'/
// 'archived') used to be written exactly once, by handle_new_auth_user()
// (0006_signup_provisioning.sql), and never read or transitioned anywhere
// else — this module deliberately did NOT filter on it, since doing so
// would have silently matched zero candidates. That is no longer true:
// routes/profile.ts now auto-activates a candidate ('incomplete' ->
// 'active') on their first successful profile save, and PATCH
// /profile/status lets a candidate explicitly pause or archive their own
// profile. profile_status is a real, candidate-controlled signal now, so
// this module filters on it:
//
//   - 'incomplete' is included. A candidate who has only just signed up
//     and never saved a profile still gets matched with zero signal,
//     producing an honest "unknown" eligibility feed entry rather than
//     being skipped — this preserves runMatchingForCandidate.ts's own
//     existing tolerance for sparse/missing candidate data (empty
//     skills/education/experience/projects and a null work_authorization
//     all resolve to eligibility 'unknown' rather than an error; see
//     matchEngine.ts).
//   - 'active' is included, obviously.
//   - 'paused' and 'archived' are EXCLUDED. This is the entire point of
//     having a candidate-controlled status at all: a candidate who has
//     explicitly paused (e.g. taking a break from the search) or archived
//     their profile should stop consuming daily matching runs, not keep
//     silently accumulating opportunity_match rows they never asked for.
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

// Keep in sync with the profile_status filtering rule documented above —
// 'paused' and 'archived' are the only statuses deliberately left out.
const MATCHABLE_PROFILE_STATUSES = ["incomplete", "active"] as const;

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
  const { data, error } = await supabase
    .from("candidate")
    .select(CANDIDATE_ID_COLUMN)
    .in("profile_status", MATCHABLE_PROFILE_STATUSES);

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
