// navBadges.ts — pure helpers for the sidebar nav badge counts (small
// Phase B follow-up gate: "nav badge polish" from the original Phase B
// audit's P2 list). shell.ts's renderShell() has always accepted a
// `badges` param (Partial<Record<string, number>>); until now every call
// site passed the default {} and no nav item ever showed a count.
//
// Deliberately minimal and honest, matching the audit's own framing of
// this as low-priority polish, not a new feature:
//   - Each page computes its OWN nav item's badge from data it already
//     fetched for itself. There is no new API call, no cross-page shared
//     state, and no attempt to show, say, Today's count while the
//     candidate is looking at Feed (that would need a second fetch this
//     gate doesn't add). A badge is simply absent (not "0", not stale)
//     for any page that hasn't computed it.
//   - No new scoring/filtering rule is introduced — feedBadgeCount below
//     reproduces the EXACT same "actionable new match" definition
//     api/src/lib/todayView.ts's summarizeItems() already uses for
//     feed_summary.new_matches_count (see that function's own comment),
//     not a new one. It's duplicated here only because the Feed page's
//     own fetch (getOpportunityFeed) returns raw items, not that
//     precomputed count — Today's own page doesn't need this function at
//     all, since view.feed_summary.new_matches_count already exists.

import type { DailyQueueItem, OpportunityFeedItem } from "./api";

/**
 * Today's own nav badge: how many items are in the Daily Queue right
 * now. `undefined` (no badge shown) when the queue itself is unavailable
 * (see dailyQueue.ts's classifyDailyQueueState) — never rendered as 0,
 * which would misrepresent "unknown" as "nothing to do."
 */
export function todayBadgeCount(dailyQueue: DailyQueueItem[] | null | undefined): number | undefined {
  if (!Array.isArray(dailyQueue)) return undefined;
  return dailyQueue.length;
}

/**
 * Feed's own nav badge: matches the candidate hasn't triaged yet
 * (inbox_status === "new"), hasn't already turned into a tracked
 * application, and aren't already known-ineligible — the same
 * definition todayView.ts's summarizeItems() uses for
 * feed_summary.new_matches_count, reproduced here (not re-derived
 * differently) so the two counts never silently disagree.
 */
export function feedBadgeCount(items: OpportunityFeedItem[]): number {
  return items.filter(
    (item) =>
      item.eligibility_status !== "ineligible" &&
      item.promoted_opportunity_id === null &&
      item.inbox_status === "new",
  ).length;
}
