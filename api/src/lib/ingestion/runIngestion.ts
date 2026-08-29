// runIngestion.ts
//
// Orchestrates the ingestion MVP: runs every configured source adapter,
// writes each adapter's results to public.opportunity_source, and
// returns a per-source summary. One adapter failing (network error,
// missing credentials, bad response shape) never prevents the others
// from running — each adapter's run()/write is wrapped independently.
//
// This module has no opinion on scheduling — it's called once per
// invocation, by api/scripts/ingest.ts (and, as of the P0 automation
// phase, a scheduled GitHub Actions workflow — see
// .github/workflows/daily-pipeline.yml — which simply runs the same
// `npm run ingest` command a human already could).
//
// DEFENSIVE NOTE (P0 automation phase): both current adapters
// (adzunaAdapter.ts, remoteokAdapter.ts) are written so their run()
// method always resolves — every internal error is caught and reported
// via AdapterRunResult.errors, never a rejected promise. The loop below
// wraps `adapter.run()` in a try/catch anyway, purely as a structural
// safety net: the SourceAdapter interface does not *guarantee* run()
// never rejects, and a manual, human-attended run tolerated that gap
// silently, but an unattended daily scheduled run should not let one
// misbehaving adapter (present or future) take down every other source
// for the day. Neither adapter's own code or behavior is changed by
// this — a rejection is now reported exactly like any other adapter
// error (fetched: 0, the error message in `errors`), not a crash.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdzunaAdapter } from "./adapters/adzunaAdapter.js";
import { createRemoteOkAdapter } from "./adapters/remoteokAdapter.js";
import { writeOpportunitySource } from "./writeOpportunitySource.js";
import type { IngestionSummary, SourceAdapter } from "./types.js";

function defaultAdapters(): SourceAdapter[] {
  return [createAdzunaAdapter(), createRemoteOkAdapter()];
}

export async function runIngestion(
  supabase: Pick<SupabaseClient, "from">,
  adapters: SourceAdapter[] = defaultAdapters()
): Promise<IngestionSummary> {
  const startedAt = new Date().toISOString();
  const sources: IngestionSummary["sources"] = [];

  for (const adapter of adapters) {
    let runResult: Awaited<ReturnType<SourceAdapter["run"]>>;
    try {
      runResult = await adapter.run();
    } catch (error) {
      // adapter.run() rejected instead of resolving with errors populated
      // (see the DEFENSIVE NOTE above) — report it as a fully failed
      // source, same shape as any other adapter error, and continue with
      // the remaining adapters rather than aborting the whole run.
      sources.push({
        sourceName: adapter.sourceName,
        fetched: 0,
        keptAfterFilter: 0,
        inserted: 0,
        updated: 0,
        failed: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      });
      continue;
    }

    if (runResult.listings.length === 0) {
      sources.push({
        sourceName: runResult.sourceName,
        fetched: runResult.fetched,
        keptAfterFilter: runResult.keptAfterFilter,
        inserted: 0,
        updated: 0,
        failed: 0,
        errors: runResult.errors,
      });
      continue;
    }

    const writeSummary = await writeOpportunitySource(supabase, runResult.sourceName, runResult.listings);

    sources.push({
      sourceName: runResult.sourceName,
      fetched: runResult.fetched,
      keptAfterFilter: runResult.keptAfterFilter,
      inserted: writeSummary.inserted,
      updated: writeSummary.updated,
      failed: writeSummary.failed,
      errors: [...runResult.errors, ...writeSummary.errors],
    });
  }

  return { startedAt, finishedAt: new Date().toISOString(), sources };
}
