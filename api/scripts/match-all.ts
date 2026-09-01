// match-all.ts
// Run with: npm run match:all
//
// WHAT THIS DOES: P0 automation phase — runs Phase 2A matching for
// EVERY candidate (see runMatchingForActiveCandidates.ts's own "ACTIVE
// CANDIDATES" doc comment for exactly what "every" means and why), by
// calling the existing, unmodified runMatchingForCandidate() once per
// candidate via runMatchingForActiveCandidates.ts. Standalone operator
// script, same pattern as ingest.ts and run-matching.ts — not a
// request-serving code path. Intended to be run daily by
// .github/workflows/daily-pipeline.yml, immediately after `npm run
// ingest`, but remains just as usable manually.
//
// This does NOT replace run-matching.ts — that script (single candidate,
// by id) is still the right tool for re-matching one candidate on
// demand (e.g. right after they finish onboarding). This script is for
// the scheduled, all-candidates case.
//
// SECURITY: like ingest.ts and run-matching.ts, this requires the
// service_role key — reading every candidate's data and writing
// opportunity_match on their behalf is an operator/scheduler-triggered,
// cross-candidate operation, not something the per-request RLS-scoped
// client is meant for. Never wire this into any request-serving code
// path. The service-role key is read from the environment and never
// printed or included in any output.
//
// EXIT CODE (mirrors ingest.ts's own partial-failure precedent exactly):
//   - Missing required env vars, or the candidate list itself failing to
//     load (RunMatchingCandidateListError — nothing to iterate safely):
//     exit 1 immediately.
//   - Every candidate failing (zero successes out of at least one
//     considered): exit 1 — this is a fatal run, not a partial one.
//   - A partial failure (some candidates succeeded, some failed): exit 0,
//     but every failure is printed by candidate id and message — this is
//     "do not silently report success when work failed," not "hide
//     partial failure by exiting non-zero for something that mostly
//     worked." A caller that wants zero tolance for any failure should
//     watch this script's own per-candidate failure output, which is
//     always printed regardless of exit code.
//   - Zero candidates considered at all: exit 0 (nothing to do is not a
//     failure — this can legitimately happen on a fresh install).
//
// USAGE:
//   cd api
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npm run match:all

import { createClient } from "@supabase/supabase-js";
import {
  runMatchingForActiveCandidates,
  RunMatchingCandidateListError,
} from "../src/lib/matching/runMatchingForActiveCandidates.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.\n" +
      "This script deliberately requires the service_role key (not the anon key) — it reads and\n" +
      "writes on behalf of every candidate as an operator/scheduler action, not a per-request one."
  );
  process.exit(1);
}

async function main() {
  const supabase = createClient(SUPABASE_URL as string, SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("InternshipOS Matching — starting run for all candidates");

  let summary;
  try {
    summary = await runMatchingForActiveCandidates(supabase);
  } catch (error) {
    if (error instanceof RunMatchingCandidateListError) {
      console.error(`\nCould not load the candidate list — nothing was matched: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  console.log(`\nCandidates considered: ${summary.candidatesConsidered}`);
  console.log(`Candidates succeeded:  ${summary.candidatesSucceeded}`);
  console.log(`Candidates failed:     ${summary.candidatesFailed}`);
  console.log(`\nResume-scoped passes considered: ${summary.resumePassesConsidered}`);
  console.log(`Resume-scoped passes succeeded:  ${summary.resumePassesSucceeded}`);
  console.log(`Resume-scoped passes failed:     ${summary.resumePassesFailed}`);
  console.log(`\nOpportunities evaluated (total, all passes): ${summary.totalOpportunitiesEvaluated}`);
  console.log(`Inserted/updated (total):        ${summary.totalInsertedOrUpdated}`);
  console.log(`Eligibility counts (total):`);
  console.log(`  eligible:   ${summary.eligibilityCounts.eligible}`);
  console.log(`  ineligible: ${summary.eligibilityCounts.ineligible}`);
  console.log(`  unknown:    ${summary.eligibilityCounts.unknown}`);

  if (summary.failures.length > 0) {
    // Candidate ids are UUIDs, not PII — safe to print. Never any other
    // candidate field is logged here.
    console.log(`\nFailures (${summary.failures.length}):`);
    for (const failure of summary.failures) {
      const passLabel = failure.resumeId ? `resume ${failure.resumeId}` : "candidate-level pass";
      console.log(`  - candidate ${failure.candidateId} (${passLabel}): ${failure.message}`);
    }
  }

  // Fatal only when every candidate that was considered failed — mirrors
  // ingest.ts's own "every source failed" exit-1 precedent. A partial
  // failure is reported above but does not fail the run, same rationale
  // ingest.ts documents: safe to run unattended without over-alerting on
  // one candidate's transient error while the rest of the batch worked.
  if (summary.candidatesConsidered > 0 && summary.candidatesSucceeded === 0) {
    console.error("\nEvery candidate failed — exiting non-zero.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Matching run crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
