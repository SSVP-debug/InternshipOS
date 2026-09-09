// types.ts (ingestion)
//
// Shared shapes for the Opportunity Intelligence ingestion MVP. Kept
// deliberately small: this is the contract between a source adapter
// (fetch + parse a specific external API) and the writer that upserts
// into public.opportunity_source.
//
// A3.3 — eligibility fields: every 0022/0023 eligibility column is now
// part of this contract (jurisdiction_country, sponsorship_offered, and
// the rest below), each `T | null`, required (not optional) on the
// interface so an adapter can never silently omit one. `null` means
// "this source does not state this axis" and is the correct, honest
// value for the vast majority of fields on both current adapters —
// Adzuna and RemoteOK provide no structured eligibility data at all, so
// only the couple of fields listed in each adapter's own comments
// (derived from explicit adapter configuration or narrow, tested
// phrase extraction) are ever non-null. Nothing here invents an
// eligibility fact; see extractEligibilitySignals.ts for the one
// deterministic extraction rule shared by both adapters.

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

  // ── A3.3 eligibility fields ─────────────────────────────────────────
  // Mirror public.opportunity_source's 0022/0023 eligibility columns
  // exactly (same names, same nullability discipline as every other
  // field on this interface). See each adapter for which of these it
  // can ever set to non-null, and why.

  /** opportunity_source.sponsorship_offered. Tri-state; null = not stated. */
  sponsorship_offered: boolean | null;
  /** opportunity_source.citizenship_requirement. Free text; null = not stated. */
  citizenship_requirement: string | null;
  /** opportunity_source.jurisdiction_country. Free-form country identifier; null = not stated. */
  jurisdiction_country: string | null;
  /** opportunity_source.eligible_candidate_countries. Null/empty = unrestricted or unstated. */
  eligible_candidate_countries: string[] | null;
  /** opportunity_source.citizenship_required_countries. Null = no structured citizenship requirement stated. */
  citizenship_required_countries: string[] | null;
  /** opportunity_source.requires_existing_work_authorization. Tri-state; null = not stated. */
  requires_existing_work_authorization: boolean | null;
  /** opportunity_source.required_degree_types. Null = not stated. */
  required_degree_types: Array<"associate" | "bachelor" | "master" | "phd" | "bootcamp" | "other"> | null;
  /** opportunity_source.required_majors. Free text; null = not stated. */
  required_majors: string[] | null;
  /** opportunity_source.required_major_match_mode. Null only when required_majors is null. */
  required_major_match_mode: "exact" | "related_field" | null;
  /** opportunity_source.graduation_not_before. ISO date (YYYY-MM-DD) or null. */
  graduation_not_before: string | null;
  /** opportunity_source.graduation_not_after. ISO date (YYYY-MM-DD) or null. */
  graduation_not_after: string | null;
  /** opportunity_source.required_enrollment_statuses. Null = not stated. */
  required_enrollment_statuses: Array<"current" | "graduated" | "on_leave" | "transferred" | "withdrawn"> | null;
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

/**
 * A3.2 — outcome of the post-ingestion expiry sweep (see
 * expireStaleOpportunities.ts). `ran: false` means the ingestion-outage
 * guard in runIngestion.ts deliberately skipped the sweep this run —
 * see `skippedReason` for why. This is distinct from the sweep running
 * and simply finding nothing to expire (`ran: true, expired: 0`).
 */
export interface SweepSummary {
  ran: boolean;
  expired: number;
  errors: string[];
  skippedReason?: string;
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
  /** A3.2 — see SweepSummary. */
  sweep: SweepSummary;
}
