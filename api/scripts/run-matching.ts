// run-matching.ts
// Run with: npm run match -- <candidate-id>
//
// WHAT THIS DOES: runs Phase 2A matching for ONE candidate — loads that
// candidate's skill/education/experience/project/work_authorization
// rows, loads every active public.opportunity_source row, maps both
// sides into matchEngine.ts's existing input types, calls the existing,
// unmodified matchCandidate() for every pair, and upserts the results
// into public.opportunity_match. Standalone operator script, same
// pattern as api/scripts/ingest.ts and check-orphan-claims.ts — not a
// request-serving code path.
//
// This script deliberately has no batch/all-candidate mode. Running it
// for every candidate is an operator choice (loop this script, or wait
// for a future scheduler) — out of scope for this phase.
//
// SECURITY: like ingest.ts, this requires the service_role key. Loading
// one candidate's data and writing opportunity_match on their behalf is
// an operator-triggered, cross-candidate-capable operation, not
// something the per-request RLS-scoped client is meant for. Never wire
// this into any request-serving code path. The service-role key is read
// from the environment and never printed or included in any output.
//
// USAGE:
//   cd api
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npm run match -- <candidate-id>
//
// The candidate id is a required positional argument. Missing it prints
// usage and exits 1 without touching the database.

import { createClient } from "@supabase/supabase-js";
import { runMatchingForCandidate } from "../src/lib/matching/runMatchingForCandidate.js";

const USAGE = "Usage: npm run match -- <candidate-id>";

const candidateId = process.argv[2];

if (!candidateId) {
  console.error(USAGE);
  console.error("Missing required argument: <candidate-id>.");
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.\n" +
      "This script deliberately requires the service_role key (not the anon key) — it reads and\n" +
      "writes on behalf of a candidate as an operator action, not a per-request authenticated one."
  );
  process.exit(1);
}

async function main() {
  const supabase = createClient(SUPABASE_URL as string, SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`InternshipOS Matching — starting run for candidate ${candidateId}`);

  const summary = await runMatchingForCandidate(supabase, candidateId as string);

  console.log(`\nOpportunities evaluated: ${summary.opportunitiesEvaluated}`);
  console.log(`Inserted/updated:        ${summary.insertedOrUpdated}`);
  console.log(`Eligibility counts:`);
  console.log(`  eligible:   ${summary.eligibilityCounts.eligible}`);
  console.log(`  ineligible: ${summary.eligibilityCounts.ineligible}`);
  console.log(`  unknown:    ${summary.eligibilityCounts.unknown}`);

  if (summary.errors.length > 0) {
    console.log(`\nErrors:`);
    for (const err of summary.errors) console.log(`  - ${err}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Matching run failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
