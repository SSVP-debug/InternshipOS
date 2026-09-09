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
import { expireStaleOpportunities } from "./expireStaleOpportunities.js";
import type { IngestionSummary, SourceAdapter, SweepSummary } from "./types.js";

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

  // A3.2 — expiry sweep, run once per pipeline invocation, after every
  // adapter has had its turn (never per-adapter — expiry is a
  // catalog-wide concern, not a per-source one).
  //
  // INGESTION-OUTAGE GUARD: only run the sweep if at least one source
  // actually wrote something this run (inserted > 0 or updated > 0).
  //
  // Deliberately NOT `fetched > 0` — fetched only means the adapter's
  // network call succeeded; it says nothing about whether any row's
  // last_seen_at actually advanced. A source can fetch real data and
  // still write nothing at all (every listing filtered out downstream,
  // or every upsert failing — e.g. Supabase reachable for reads but not
  // writes, a bad service-role key, a table-level outage): in every one
  // of those cases fetched > 0 while inserted and updated both stay 0,
  // and last_seen_at never moves for a single row. Gating on fetched
  // would let the sweep run believing the catalog was just refreshed
  // when nothing was actually refreshed — exactly the false-positive
  // this guard exists to prevent.
  //
  // Why this matters: last_seen_at only advances on a successful write.
  // If EVERY source failed to write anything this run (bad credentials,
  // both APIs down, Supabase unreachable for writes, every upsert
  // rejected), no row's last_seen_at moved — and treating that silence
  // as 14 days closer to expiry would eventually start expiring
  // perfectly live opportunities for a reason that has nothing to do
  // with them actually disappearing. A partial run (one source down,
  // one source writing successfully) is normal daily operation and does
  // NOT trip this guard — only a run where nothing was written anywhere
  // does.
  const anySourceWroteSomething = sources.some((s) => s.inserted > 0 || s.updated > 0);

  let sweep: SweepSummary;
  if (anySourceWroteSomething) {
    const sweepResult = await expireStaleOpportunities(supabase);
    sweep = { ran: true, expired: sweepResult.expired, errors: sweepResult.errors };
  } else {
    sweep = {
      ran: false,
      expired: 0,
      errors: [],
      skippedReason:
        "no source successfully wrote anything this run (fetch failures, filtered-out results, or " +
        "write failures) — skipping the expiry sweep so a total write outage never gets mistaken for " +
        "opportunities actually disappearing",
    };
  }

  return { startedAt, finishedAt: new Date().toISOString(), sources, sweep };
}
