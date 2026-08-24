// runIngestion.ts
//
// Orchestrates the ingestion MVP: runs every configured source adapter,
// writes each adapter's results to public.opportunity_source, and
// returns a per-source summary. One adapter failing (network error,
// missing credentials, bad response shape) never prevents the others
// from running — each adapter's run()/write is wrapped independently.
//
// This module has no opinion on scheduling — it's called once per
// invocation, by api/scripts/ingest.ts today. Wiring it to a cron/
// scheduler is a later, separate milestone (explicitly out of scope
// here per the task brief).

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
    const runResult = await adapter.run();

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
