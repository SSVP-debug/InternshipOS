// dailyQueue.ts
// Phase B1 — pure Daily Queue derivation. "What should this student do
// next?" (Phase B audit, approved design). Same discipline as
// todayView.ts and opportunityFeed.ts: no supabase/Express/network/
// filesystem dependency at all, so this is directly unit-testable and the
// route layer (a later gate) stays a thin fetch-and-call wrapper.
//
// This module does NOT recompute anything A3.1/A3.2/A3.3 already own:
//   - It consumes buildOpportunityFeed()'s own output (opportunityFeed.ts,
//     UNMODIFIED) to get match/source joining, the A3.1 score-floor
//     filter, the A3.3 duplicate-source collapsing, and the "only active
//     opportunity_source rows" (A3.2 expiry) filter — all for free, all
//     already tested there. Re-implementing any of that here would be
//     exactly the "second, independently-tuned notion of actionable" this
//     codebase's own comments repeatedly warn against (see
//     opportunityFeed.ts's todayView.ts-facing summarizeItems()).
//   - It consumes the caller's own TodayActionItem[] (todayView.ts,
//     UNMODIFIED) for application urgency (deadlines/follow-ups) rather
//     than re-deriving urgency from raw application rows.
//
// This module's only job is the part that doesn't exist anywhere yet:
// merging those two already-correct, already-ranked lists into one small,
// deterministic, explainable queue.
//
// B1 is intentionally flat (see the gate brief's "Important Product
// Constraints"): no resume-scoping, no new score, no persistence, no
// "reviewed"/"not interested" state, no deadline inference for unapplied
// opportunities (that's the explicitly separate, future B5 gate). Do not
// add any of that here without a new design sign-off.

import type { TodayActionItem } from "./todayView.js";
import {
  buildOpportunityFeed,
  MIN_SURFACED_MATCH_SCORE,
  type OpportunityFeedItem,
  type OpportunityMatchRow,
  type OpportunitySourceRow,
} from "./opportunityFeed.js";

/** At most this many items are ever returned, regardless of how many are eligible. */
export const DAILY_QUEUE_CAP = 5;

export type DailyQueueReason = "action_required" | "match";

export interface DailyQueueActionItem {
  reason: "action_required";
  /** Stable dedup/identity key: the underlying application id. */
  id: string;
  action: TodayActionItem;
}

export interface DailyQueueOpportunityItem {
  reason: "match";
  /** Stable dedup/identity key: the underlying opportunity_match id. */
  id: string;
  opportunity: OpportunityFeedItem;
}

export type DailyQueueItem = DailyQueueActionItem | DailyQueueOpportunityItem;

export interface DailyQueueInput {
  /**
   * The caller's own TodayView.action_required (todayView.ts) — already
   * the existing definition of "an application needs attention today"
   * (deadline ≤3 days pre-apply, or a follow-up due/overdue). Not
   * required to be pre-sorted; this function sorts its own copy so the
   * output is deterministic regardless of what order the caller passes.
   */
  actionRequired: TodayActionItem[];
  /**
   * The caller's own candidate-scoped opportunity_match rows (same shape
   * opportunity-feed.ts's GET /opportunity-feed and today.ts already
   * fetch). Passed raw (not pre-joined) so this module can run them
   * through the UNMODIFIED buildOpportunityFeed() itself — see header.
   */
  matches: OpportunityMatchRow[];
  /** The caller's own opportunity_source rows — see `matches` above. */
  sources: OpportunitySourceRow[];
}

function toActionQueueItem(action: TodayActionItem): DailyQueueActionItem {
  return { reason: "action_required", id: action.application_id, action };
}

function toOpportunityQueueItem(item: OpportunityFeedItem): DailyQueueOpportunityItem {
  return { reason: "match", id: item.opportunity_match_id, opportunity: item };
}

/**
 * Deterministic action-required ordering: most urgent first
 * (days_until_due ascending — mirrors todayView.ts's own
 * actionRequired.sort), then application_id ascending as a stable
 * tie-breaker for equal urgency (same-day deadlines, etc.).
 */
function compareActionItems(a: TodayActionItem, b: TodayActionItem): number {
  if (a.days_until_due !== b.days_until_due) return a.days_until_due - b.days_until_due;
  return a.application_id.localeCompare(b.application_id);
}

/**
 * Deterministic opportunity ordering: existing match_score descending
 * (the only ranking signal this gate is allowed to use — no new scoring
 * model), then the same opportunity_source_id tie-breaker
 * buildOpportunityFeed() itself uses, then opportunity_match_id as a
 * final tie-breaker for full determinism even if two matches somehow
 * share both score and source id.
 */
function compareOpportunityItems(a: OpportunityFeedItem, b: OpportunityFeedItem): number {
  if (a.match_score !== b.match_score) return b.match_score - a.match_score;
  if (a.opportunity_source_id !== b.opportunity_source_id) {
    return a.opportunity_source_id.localeCompare(b.opportunity_source_id);
  }
  return a.opportunity_match_id.localeCompare(b.opportunity_match_id);
}

/**
 * Queue-membership rule for an opportunity match, on top of whatever
 * buildOpportunityFeed() already filtered (active source, A3.1 score
 * floor, A3.3 dedup collapse):
 *   - inbox_status === "new" — the candidate hasn't triaged it yet. A
 *     saved/dismissed match is a resolved decision, not something to
 *     re-surface as "what should I do next."
 *   - promoted_opportunity_id === null — already turned into a tracked
 *     application; that's the action_required side's job to surface
 *     (via its own deadline/follow-up logic), not this one's. This is
 *     also what prevents the same underlying opportunity from ever
 *     appearing as both an action_required item and a match item (see
 *     module header / dedup discussion in tests).
 */
function isQueueEligibleMatch(item: OpportunityFeedItem): boolean {
  return item.inbox_status === "new" && item.promoted_opportunity_id === null;
}

/**
 * Builds the flat, deterministic Daily Queue described by the Phase B1
 * design: action-required items first (existing Today urgency, unchanged
 * ordering), then untriaged opportunity matches (existing A3.1
 * match_score, unchanged), merged, deduplicated, capped at
 * DAILY_QUEUE_CAP. No I/O, no randomness, no new scoring.
 */
export function buildDailyQueue(input: DailyQueueInput): DailyQueueItem[] {
  const { actionRequired, matches, sources } = input;

  // Reuse buildOpportunityFeed() as-is: this is what gives the queue A3.1's
  // score floor, A3.2's active-only (expiry-aware) filtering, and A3.3's
  // duplicate-source collapsing for free, without re-implementing any of
  // it here.
  const feedItems = buildOpportunityFeed(matches, sources);

  const eligibleOpportunities = feedItems.filter(isQueueEligibleMatch);

  const orderedActions = [...actionRequired].sort(compareActionItems);
  const orderedOpportunities = [...eligibleOpportunities].sort(compareOpportunityItems);

  // Dedup: guard against the same identity appearing twice within either
  // input (defensive — callers are expected to already pass clean data,
  // same posture as buildOpportunityFeed's own defensiveness) and against
  // the same underlying opportunity appearing through both inputs (an
  // opportunity_match row whose promoted_opportunity_id happens to match
  // an action_required item's opportunity_id — isQueueEligibleMatch above
  // already excludes any promoted match, so this is a second, explicit
  // safety net rather than the only line of defense).
  const seen = new Set<string>();
  const seenOpportunityIds = new Set(orderedActions.map((a) => a.opportunity_id));

  const queue: DailyQueueItem[] = [];

  for (const action of orderedActions) {
    const key = `action:${action.application_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(toActionQueueItem(action));
  }

  for (const opportunity of orderedOpportunities) {
    const key = `match:${opportunity.opportunity_match_id}`;
    if (seen.has(key)) continue;
    // Belt-and-braces: never surface an opportunity match whose promoted
    // opportunity is the same one an action_required item already covers.
    if (opportunity.promoted_opportunity_id && seenOpportunityIds.has(opportunity.promoted_opportunity_id)) continue;
    seen.add(key);
    queue.push(toOpportunityQueueItem(opportunity));
  }

  // Cap AFTER concatenation, not per-section — action-required items
  // always occupy the front of `queue` (pushed first, above), so a
  // straight slice already implements "keep the highest-priority
  // action-required items first, then the highest-ranked opportunity
  // suggestions, then truncate."
  return queue.slice(0, DAILY_QUEUE_CAP);
}

// Re-exported for callers/tests that want to reference the same floor
// this module relies on (via buildOpportunityFeed) without importing
// opportunityFeed.ts directly for it.
export { MIN_SURFACED_MATCH_SCORE };
