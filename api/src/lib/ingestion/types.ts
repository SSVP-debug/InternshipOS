// types.ts (ingestion)
//
// Shared shapes for the Opportunity Intelligence ingestion MVP. Kept
// deliberately small: this is the contract between a source adapter
// (fetch + parse a specific external API) and the writer that upserts
// into public.opportunity_source. Nothing here encodes eligibility —
// the 0023_country_neutral_eligibility.sql columns are left NULL by
// every adapter in this milestone; structured eligibility extraction is
// a later phase, not part of ingestion.

/**
 * The normalized shape every adapter must produce, one per real posting.
 * Field names and value domains mirror public.opportunity_source
 * (0022_opportunity_intelligence_foundation.sql) exactly, so
 * writeOpportunitySource.ts can pass this straight into an upsert
 * without any adapter-specific branching.
 */
export interface CanonicalListing {
  source_type: "job_board";
  /** Adapter name, e.g. "adzuna" | "remoteok" — used to build the dedup fingerprint. */
  source_name: string;
  /** The native id/slug from the source API. Must be stable across runs. */
  source_ref: string;
  source_url: string | null;

  title: string;
  company: string;
  description: string | null;
  location: string | null;
  work_mode: "remote" | "hybrid" | "onsite" | null;
  employment_type: "internship" | "co_op" | "full_time" | "part_time";
  skills: string[];
  application_url: string | null;
  deadline_date: string | null; // ISO date (YYYY-MM-DD) or null
  posted_date: string | null; // ISO date (YYYY-MM-DD) or null
}

/** A single adapter's fetch+parse outcome, isolated from other adapters. */
export interface AdapterRunResult {
  sourceName: string;
  fetched: number;
  keptAfterFilter: number;
  listings: CanonicalListing[];
  errors: string[];
}

/** What every source adapter implements. */
export interface SourceAdapter {
  sourceName: string;
  run(): Promise<AdapterRunResult>;
}

/** Per-adapter write outcome, after upserting into opportunity_source. */
export interface WriteSummary {
  sourceName: string;
  inserted: number;
  updated: number;
  failed: number;
  errors: string[];
}

/** Full pipeline summary returned by runIngestion() and printed by the CLI. */
export interface IngestionSummary {
  startedAt: string;
  finishedAt: string;
  sources: Array<{
    sourceName: string;
    fetched: number;
    keptAfterFilter: number;
    inserted: number;
    updated: number;
    failed: number;
    errors: string[];
  }>;
}
