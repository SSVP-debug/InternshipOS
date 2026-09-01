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
//
// GATE R2 — RESUME PASSES: for every candidate, this now runs
// runMatchingForCandidate.ts TWICE PER RESUME they have active, in
// addition to the existing candidate-level pass (resumeId = null),
// which is UNCHANGED in meaning and still drives candidatesConsidered/
// candidatesSucceeded/candidatesFailed exactly as before Gate R2 — a
// consumer reading only those three fields (e.g. match-all.ts's console
// output) sees identical behavior to pre-R2. Resume-scoped passes are
// tracked separately (resumePassesConsidered/Succeeded/Failed) rather
// than folded into the candidate-level counts, since "candidate
// succeeded" and "this one resume's pass succeeded" are different
// claims — see each field's own doc comment below. Archived resumes
// (is_active = false) are skipped entirely, per the design doc's
// lifecycle section — the batch orchestrator is where that filter is
// applied, not RLS.

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
  /** Gate R2: null = the candidate-level pass, a resume id = that resume's scoped pass. */
  resumeId: string | null;
  opportunitiesEvaluated: number;
  insertedOrUpdated: number;
  eligibilityCounts: EligibilityCounts;
  errors: string[];
}

export interface CandidateMatchFailure {
  candidateId: string;
  /** Gate R2: null = the candidate-level pass failed, a resume id = that resume's scoped pass failed. */
  resumeId: string | null;
  message: string;
}

export interface RunMatchingForActiveCandidatesSummary {
  /** Unchanged since before Gate R2: candidates loaded from public.candidate per the profile_status filter. */
  candidatesConsidered: number;
  /** Unchanged meaning: whether each candidate's own candidate-level (resumeId=null) pass succeeded. Does NOT reflect resume-pass outcomes — see resumePassesSucceeded for those. */
  candidatesSucceeded: number;
  candidatesFailed: number;
  /** Gate R2: total resume-scoped passes attempted across all candidates (sum of each candidate's active resume count). */
  resumePassesConsidered: number;
  resumePassesSucceeded: number;
  resumePassesFailed: number;
  /** Aggregated across BOTH the candidate-level pass and every resume-scoped pass for every candidate. */
  totalOpportunitiesEvaluated: number;
  totalInsertedOrUpdated: number;
  eligibilityCounts: EligibilityCounts;
  /** One entry per (candidate, pass) that succeeded — resumeId distinguishes the candidate-level pass (null) from each resume pass. */
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

/**
 * Gate R2: which of this candidate's resumes are currently active
 * (is_active = true) — archived resumes are skipped by the batch run
 * entirely, per docs/gate-r0-resume-design.md §3 ("the batch matching
 * orchestrator should skip archived resumes when generating new daily
 * matches"). Filters is_active in application code after a single
 * candidate_id-scoped read, rather than a second .eq() in the query
 * chain — deliberately the simplest thing that works, not a
 * micro-optimization worth adding query-builder complexity for at this
 * candidate-by-candidate call volume.
 */
async function loadActiveResumeIdsForCandidate(
  supabase: Pick<SupabaseClient, "from">,
  candidateId: string
): Promise<string[]> {
  const { data, error } = await supabase.from("resume").select("id, is_active").eq("candidate_id", candidateId);

  if (error) {
    throw new RunMatchingReadError(`Failed to load resumes for candidate ${candidateId}: ${error.message}`);
  }

  return ((data ?? []) as unknown as Array<{ id: string; is_active: boolean }>)
    .filter((row) => row.is_active)
    .map((row) => row.id);
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
/**
 * Runs one matching pass (candidate-level or resume-scoped) and records
 * the outcome into the shared accumulators. Isolates a single pass's
 * failure (thrown read error, or a reported write error in
 * result.errors) from every other pass — candidate-level and every
 * resume pass for every candidate are independent units of work here,
 * matching this module's pre-existing "one candidate's failure doesn't
 * stop the batch" guarantee, now applied one level more granularly.
 */
async function runOnePass(
  supabase: Pick<SupabaseClient, "from" | "rpc">,
  candidateId: string,
  resumeId: string | null,
  perCandidate: CandidateMatchOutcome[],
  failures: CandidateMatchFailure[],
  totals: { opportunitiesEvaluated: number; insertedOrUpdated: number },
  eligibilityCounts: EligibilityCounts
): Promise<boolean> {
  let result: RunMatchingSummary;
  try {
    result = await runMatchingForCandidate(supabase, candidateId, resumeId);
  } catch (error) {
    const message = error instanceof RunMatchingReadError || error instanceof Error ? error.message : String(error);
    failures.push({ candidateId, resumeId, message });
    return false;
  }

  // runMatchingForCandidate itself never throws for a failed
  // opportunity_match write — it reports that failure in result.errors
  // instead (see its own tests). Surface that here too, as a failure
  // entry, rather than counting a pass as "succeeded" when its matches
  // were never actually persisted.
  if (result.errors.length > 0) {
    failures.push({ candidateId, resumeId, message: result.errors.join("; ") });
    return false;
  }

  perCandidate.push({
    candidateId,
    resumeId,
    opportunitiesEvaluated: result.opportunitiesEvaluated,
    insertedOrUpdated: result.insertedOrUpdated,
    eligibilityCounts: result.eligibilityCounts,
    errors: result.errors,
  });
  totals.opportunitiesEvaluated += result.opportunitiesEvaluated;
  totals.insertedOrUpdated += result.insertedOrUpdated;
  addEligibilityCounts(eligibilityCounts, result.eligibilityCounts);
  return true;
}

export async function runMatchingForActiveCandidates(
  supabase: Pick<SupabaseClient, "from" | "rpc">
): Promise<RunMatchingForActiveCandidatesSummary> {
  const candidateIds = await loadAllCandidateIds(supabase);

  const perCandidate: CandidateMatchOutcome[] = [];
  const failures: CandidateMatchFailure[] = [];
  const eligibilityCounts = emptyEligibilityCounts();
  const totals = { opportunitiesEvaluated: 0, insertedOrUpdated: 0 };

  let candidatesSucceeded = 0;
  let candidatesFailed = 0;
  let resumePassesConsidered = 0;
  let resumePassesSucceeded = 0;
  let resumePassesFailed = 0;

  for (const candidateId of candidateIds) {
    // Candidate-level pass — unchanged in meaning from before Gate R2.
    const baseSucceeded = await runOnePass(
      supabase,
      candidateId,
      null,
      perCandidate,
      failures,
      totals,
      eligibilityCounts
    );
    if (baseSucceeded) {
      candidatesSucceeded++;
    } else {
      candidatesFailed++;
    }

    // Gate R2 — one additional pass per active resume. A failure loading
    // the resume list itself is recorded as its own failure entry
    // (resumeId: null is already taken by the candidate-level pass
    // above, so this uses a distinct message rather than a second
    // resumeId: null failure that would be ambiguous to a reader of
    // `failures`) and simply means zero resume passes run for this
    // candidate this round — it does not retroactively undo the
    // candidate-level pass above.
    let activeResumeIds: string[];
    try {
      activeResumeIds = await loadActiveResumeIdsForCandidate(supabase, candidateId);
    } catch (error) {
      const message = error instanceof RunMatchingReadError || error instanceof Error ? error.message : String(error);
      failures.push({ candidateId, resumeId: null, message: `Failed to load resumes: ${message}` });
      continue;
    }

    for (const resumeId of activeResumeIds) {
      resumePassesConsidered++;
      const succeeded = await runOnePass(
        supabase,
        candidateId,
        resumeId,
        perCandidate,
        failures,
        totals,
        eligibilityCounts
      );
      if (succeeded) {
        resumePassesSucceeded++;
      } else {
        resumePassesFailed++;
      }
    }
  }

  return {
    candidatesConsidered: candidateIds.length,
    candidatesSucceeded,
    candidatesFailed,
    resumePassesConsidered,
    resumePassesSucceeded,
    resumePassesFailed,
    totalOpportunitiesEvaluated: totals.opportunitiesEvaluated,
    totalInsertedOrUpdated: totals.insertedOrUpdated,
    eligibilityCounts,
    perCandidate,
    failures,
  };
}
