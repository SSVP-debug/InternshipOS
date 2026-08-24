// writeOpportunitySource.ts
//
// Upserts CanonicalListing[] into public.opportunity_source. Must be
// called with a service-role Supabase client — 0022 deliberately left
// no INSERT/UPDATE/DELETE policy for the `authenticated` role on this
// table (see the migration's RLS comment), so an anon/user-scoped
// client cannot write here at all. The caller (runIngestion.ts) is
// responsible for constructing that client; this module has no opinion
// on how credentials are loaded.
//
// Upsert key is dedup_fingerprint (unique, not null per 0022) — re-
// running ingestion updates the existing row's fields + last_seen_at
// instead of creating a duplicate. first_seen_at, created_at, status,
// and every 0023 eligibility column are intentionally left alone on
// conflict: first_seen_at should never move once set, and neither
// ingestion source produces eligibility data in this milestone.

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeDedupFingerprint } from "./dedupFingerprint.js";
import type { CanonicalListing, WriteSummary } from "./types.js";

// Supabase JS upsert() does one round trip per call but batches rows
// within a call — chunk to keep any single request body reasonable.
const UPSERT_BATCH_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function writeOpportunitySource(
  supabase: Pick<SupabaseClient, "from">,
  sourceName: string,
  listings: CanonicalListing[]
): Promise<WriteSummary> {
  const errors: string[] = [];
  let inserted = 0;
  let updated = 0;
  let failed = 0;

  const rows = listings.map((listing) => ({
    source_type: listing.source_type,
    source_ref: listing.source_ref,
    source_url: listing.source_url,
    title: listing.title,
    company: listing.company,
    description: listing.description,
    location: listing.location,
    work_mode: listing.work_mode,
    employment_type: listing.employment_type,
    skills: listing.skills,
    application_url: listing.application_url,
    deadline_date: listing.deadline_date,
    posted_date: listing.posted_date,
    dedup_fingerprint: computeDedupFingerprint(listing.source_name, listing.source_ref),
    last_seen_at: new Date().toISOString(),
    status: "active" as const,
  }));

  for (const batch of chunk(rows, UPSERT_BATCH_SIZE)) {
    // Read existing fingerprints first so insert/update can be reported
    // accurately — upsert() alone doesn't tell the caller which branch
    // each row took.
    const fingerprints = batch.map((row) => row.dedup_fingerprint);
    const { data: existing, error: readError } = await supabase
      .from("opportunity_source")
      .select("dedup_fingerprint")
      .in("dedup_fingerprint", fingerprints);

    if (readError) {
      failed += batch.length;
      errors.push(`pre-upsert lookup failed for a batch of ${batch.length}: ${readError.message}`);
      continue;
    }

    const existingSet = new Set((existing ?? []).map((row: { dedup_fingerprint: string }) => row.dedup_fingerprint));

    const { error: upsertError } = await supabase
      .from("opportunity_source")
      .upsert(batch, { onConflict: "dedup_fingerprint" });

    if (upsertError) {
      failed += batch.length;
      errors.push(`upsert failed for a batch of ${batch.length}: ${upsertError.message}`);
      continue;
    }

    for (const row of batch) {
      if (existingSet.has(row.dedup_fingerprint)) {
        updated++;
      } else {
        inserted++;
      }
    }
  }

  return { sourceName, inserted, updated, failed, errors };
}
