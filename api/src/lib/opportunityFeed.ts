// opportunityFeed.ts
//
// Pure builder for the personalized opportunity feed (Phase 2B). No I/O
// of any kind — same discipline as todayView.ts and the Phase 2A pure
// mappers (buildCandidateMatchInput.ts / buildOpportunityMatchInput.ts).
// The route (opportunity-feed.ts) is the only caller responsible for
// actually fetching rows and handing them here.
//
// This module does NOT recompute match_score, does NOT infer eligibility,
// and does NOT add any ranking beyond the deterministic ordering
// specified below — match_score itself is Phase 2A's unmodified
// matchEngine.ts output, already stored on the opportunity_match row.

export interface OpportunityMatchRow {
  id: string;
  opportunity_source_id: string;
  match_score: number;
  eligibility_status: "eligible" | "ineligible" | "unknown";
  match_breakdown: unknown;
  inbox_status: "new" | "saved" | "dismissed";
  is_priority: boolean;
  // Set by the candidate's Apply flow once they've turned this match into
  // a tracked application (see opportunity-feed.ts's PATCH handler and
  // the frontend's opportunityFeed.ts page). Null until then. Purely
  // pass-through here — this module does not write it or infer it.
  promoted_opportunity_id: string | null;
}

export interface OpportunitySourceRow {
  id: string;
  title: string;
  company: string;
  location: string | null;
  work_mode: string | null;
  employment_type: string;
  posted_date: string | null;
  application_url: string | null;
  status: string;
}

export interface OpportunityFeedItem {
  opportunity_match_id: string;
  opportunity_source_id: string;
  title: string;
  company: string;
  location: string | null;
  work_mode: string | null;
  employment_type: string;
  posted_date: string | null;
  application_url: string | null;
  match_score: number;
  eligibility_status: "eligible" | "ineligible" | "unknown";
  match_reasons: string[];
  match_missing: string[];
  match_unknown: string[];
  inbox_status: "new" | "saved" | "dismissed";
  is_priority: boolean;
  promoted_opportunity_id: string | null;
}

/**
 * Pulls reasons/missing/unknown out of match_breakdown (the jsonb column
 * Phase 2A's runMatchingForCandidate.ts writes as
 * `{ breakdown, reasons, missing, unknown }`). Defensive against any
 * shape mismatch — malformed/missing/non-object data safely yields empty
 * arrays rather than throwing, since a display glitch here must never
 * take down the whole feed request.
 */
function extractExplanation(matchBreakdown: unknown): { reasons: string[]; missing: string[]; unknown: string[] } {
  const empty = { reasons: [] as string[], missing: [] as string[], unknown: [] as string[] };

  if (!matchBreakdown || typeof matchBreakdown !== "object") return empty;

  const record = matchBreakdown as Record<string, unknown>;
  const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

  return {
    reasons: asStringArray(record.reasons),
    missing: asStringArray(record.missing),
    unknown: asStringArray(record.unknown),
  };
}

/**
 * Joins opportunity_match rows to active opportunity_source rows and
 * orders the result. A match whose opportunity_source_id has no
 * corresponding row in `sources` (deleted, or simply not passed in
 * because it isn't active — see the route, which only fetches active
 * rows) is dropped silently, never thrown on: a stale match pointing at
 * an opportunity that's no longer active is expected, not an error
 * condition.
 *
 * Ordering (deterministic, no ranking logic beyond this):
 *   1. match_score descending
 *   2. posted_date descending, nulls last
 *   3. opportunity_source_id ascending (stable tie-breaker)
 */
export function buildOpportunityFeed(
  matches: OpportunityMatchRow[],
  sources: OpportunitySourceRow[]
): OpportunityFeedItem[] {
  const activeSourcesById = new Map<string, OpportunitySourceRow>();
  for (const source of sources) {
    if (source.status === "active") {
      activeSourcesById.set(source.id, source);
    }
  }

  const items: OpportunityFeedItem[] = [];

  for (const match of matches) {
    const source = activeSourcesById.get(match.opportunity_source_id);
    if (!source) continue; // missing or inactive source — drop safely, never throw

    const { reasons, missing, unknown } = extractExplanation(match.match_breakdown);

    items.push({
      opportunity_match_id: match.id,
      opportunity_source_id: match.opportunity_source_id,
      title: source.title,
      company: source.company,
      location: source.location,
      work_mode: source.work_mode,
      employment_type: source.employment_type,
      posted_date: source.posted_date,
      application_url: source.application_url,
      match_score: match.match_score,
      eligibility_status: match.eligibility_status,
      match_reasons: reasons,
      match_missing: missing,
      match_unknown: unknown,
      inbox_status: match.inbox_status,
      is_priority: match.is_priority,
      promoted_opportunity_id: match.promoted_opportunity_id,
    });
  }

  items.sort((a, b) => {
    if (a.match_score !== b.match_score) return b.match_score - a.match_score;

    if (a.posted_date !== b.posted_date) {
      if (a.posted_date === null) return 1; // nulls last
      if (b.posted_date === null) return -1;
      return b.posted_date.localeCompare(a.posted_date); // descending
    }

    return a.opportunity_source_id.localeCompare(b.opportunity_source_id); // ascending tie-breaker
  });

  return items;
}
