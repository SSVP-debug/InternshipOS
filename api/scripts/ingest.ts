// ingest.ts
// Run with: npm run ingest
//
// WHAT THIS DOES: fetches internship postings from the two configured
// source adapters (Adzuna — India-first, RemoteOK — international/
// remote), normalizes and filters them, and upserts them into
// public.opportunity_source. Standalone operator script, same pattern
// as api/scripts/check-orphan-claims.ts — not a request-serving code
// path, run manually (or later from a scheduler, not built yet).
//
// SECURITY: like check-orphan-claims.ts, this deliberately requires the
// service_role key. 0022_opportunity_intelligence_foundation.sql leaves
// no INSERT/UPDATE/DELETE policy for the `authenticated` role on
// opportunity_source on purpose — writes to this table are service-role
// only. Never wire this script into any request-serving code path.
//
// USAGE:
//   cd api
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   ADZUNA_APP_ID=... ADZUNA_APP_KEY=... \
//   npm run ingest
//
// If ADZUNA_APP_ID/ADZUNA_APP_KEY are unset, the Adzuna source is
// skipped (reported in the summary, not a hard failure) — RemoteOK
// needs no credentials and still runs. Exits 1 only if every configured
// source failed outright (fetched: 0 and errors present for all of
// them); a partial run (one source down, one source fine) exits 0 so
// it's safe to run unattended without over-alerting.

import { createClient } from "@supabase/supabase-js";
import { runIngestion } from "../src/lib/ingestion/runIngestion.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error(
    "Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.\n" +
      "This script deliberately requires the service_role key (not the anon key) — writes to\n" +
      "public.opportunity_source are service-role only; see 0022_opportunity_intelligence_foundation.sql."
  );
  process.exit(1);
}

async function main() {
  const supabase = createClient(SUPABASE_URL as string, SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log("InternshipOS Ingestion — starting run");
  const summary = await runIngestion(supabase);

  let anySucceeded = false;

  for (const source of summary.sources) {
    console.log(`\n[${source.sourceName}]`);
    console.log(`  fetched:            ${source.fetched}`);
    console.log(`  kept (internships): ${source.keptAfterFilter}`);
    console.log(`  inserted:           ${source.inserted}`);
    console.log(`  updated:            ${source.updated}`);
    console.log(`  failed:             ${source.failed}`);
    if (source.errors.length > 0) {
      console.log(`  errors:`);
      for (const err of source.errors) console.log(`    - ${err}`);
    }
    if (source.fetched > 0 || source.inserted > 0 || source.updated > 0) {
      anySucceeded = true;
    }
  }

  console.log(`\nStarted:  ${summary.startedAt}`);
  console.log(`Finished: ${summary.finishedAt}`);

  if (!anySucceeded) {
    console.error("\nEvery configured source failed — exiting non-zero.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Ingestion run crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
