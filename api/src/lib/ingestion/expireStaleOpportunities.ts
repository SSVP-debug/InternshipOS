// expireStaleOpportunities.ts
//
// A3.2 — Opportunity Freshness & Expiry. The sole writer of
// opportunity_source.status = 'expired'. Per the approved A3.2 design:
//
//   - Trigger: status = 'active' AND last_seen_at < now() - 14 days.
//     Strict "<" per the approved spec — a row exactly 14 days old is
//     NOT expired yet, only one that is OLDER than the threshold.
//   - Only 'active' rows are ever touched. A row already 'expired' is
//     left alone (idempotent — re-running this never re-expires or
//     double-counts a row).
//   - Only 'expired' is ever written here. 'removed' is explicitly out
//     of scope for A3.2 (per the audit: no source gives InternshipOS a
//     genuine "this posting was withdrawn" signal today — only
//     accumulated absence, which is 'expired' territory, not
//     'removed').
//   - No new table, no ingestion-run history: last_seen_at (bumped on
//     every successful write by writeOpportunitySource.ts) is already
//     sufficient evidence — this module reads it, it doesn't add new
//     bookkeeping.
//
// This module does NOT decide whether it's safe to run at all — that's
// the ingestion-outage guard, which lives in runIngestion.ts (the
// caller), not here. This module trusts its caller and only knows how
// to run the sweep query itself, exactly like writeOpportunitySource.ts
// only knows how to run the upsert and leaves orchestration to its
// caller.
//
// Must be called with a service-role Supabase client, same requirement
// as writeOpportunitySource.ts — 0022_opportunity_intelligence_foundation.sql
// leaves no UPDATE policy for the `authenticated` role on
// opportunity_source, so an anon/user-scoped client could not perform
// this write even if it tried.

import type { SupabaseClient } from "@supabase/supabase-js";

export const STALE_THRESHOLD_DAYS = 14;

export interface ExpireStaleOpportunitiesResult {
  /** Count of opportunity_source rows actually transitioned active -> expired this call. */
  expired: number;
  errors: string[];
}

function cutoffIsoString(now: Date, thresholdDays: number): string {
  return new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Runs the deterministic staleness sweep once. `now` is injectable
 * (defaults to the real current time) purely so tests can exercise the
 * 14-day boundary precisely without depending on wall-clock time.
 */
export async function expireStaleOpportunities(
  supabase: Pick<SupabaseClient, "from">,
  now: Date = new Date()
): Promise<ExpireStaleOpportunitiesResult> {
  const cutoff = cutoffIsoString(now, STALE_THRESHOLD_DAYS);

  // .select("id") after .update(...) asks PostgREST to return the
  // updated rows (not just an ack) so the caller gets an honest count of
  // how many rows actually transitioned — same "don't just trust the
  // write call, verify what happened" discipline writeOpportunitySource.ts
  // uses for insert/update counts.
  const { data, error } = await supabase
    .from("opportunity_source")
    .update({ status: "expired" })
    .eq("status", "active")
    .lt("last_seen_at", cutoff)
    .select("id");

  if (error) {
    return { expired: 0, errors: [`expiry sweep failed: ${error.message}`] };
  }

  return { expired: (data ?? []).length, errors: [] };
}
