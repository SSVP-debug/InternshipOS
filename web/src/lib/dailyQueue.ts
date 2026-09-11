// dailyQueue.ts (frontend) — pure display-logic helpers for the Phase B3
// "What should I do next?" section on pages/today.ts. Deliberately
// separated from that file the same way lib/dom.ts's errorMessage() is
// separated from its DOM-building h()/toast(): this repo's frontend test
// setup (vitest.config.ts) is intentionally node-only, with no jsdom/DOM
// rendering capability, so anything worth unit-testing here has to be a
// pure function with no `document`/`window` dependency. Actual rendering
// (building HTMLElements, wiring click handlers) stays in today.ts and is
// exercised by typecheck + production build + manual verification, same
// as every other page in this codebase today.
//
// None of this re-ranks, re-filters, or re-caps the queue — that would
// violate B3's "the backend order is authoritative" rule. These are
// display-formatting decisions only.

import type { DailyQueueItem, OpportunityFeedItem } from "./api";

export type DailyQueueRenderState = "unavailable" | "empty" | "items";

/**
 * Distinguishes "the API told us there's nothing eligible right now"
 * (an honest, empty queue) from "the API response didn't actually include
 * a daily_queue field" (a data/versioning problem). Today's page must
 * never render the fallback ("You're all caught up") for the latter —
 * that would be exactly the kind of unsupported claim A2 Honest UX
 * forbids: telling a candidate they have no urgent work when the truth is
 * "we couldn't tell."
 */
export function classifyDailyQueueState(dailyQueue: DailyQueueItem[] | null | undefined): DailyQueueRenderState {
  if (!Array.isArray(dailyQueue)) return "unavailable";
  if (dailyQueue.length === 0) return "empty";
  return "items";
}

/** Stable React-less "key" for a queue item — unique across both item kinds. */
export function dailyQueueItemKey(item: DailyQueueItem): string {
  return `${item.reason}:${item.id}`;
}

/**
 * The company/location/work-mode/employment-type summary line for a
 * `match` queue item — same fields, same join order, and same
 * null-skipping behavior as pages/opportunityFeed.ts's renderCard()
 * uses for the identical data, so a match looks the same whether a
 * candidate sees it in the queue or in the full Feed.
 */
export function formatMatchMeta(opportunity: OpportunityFeedItem): string {
  const parts = [opportunity.company];
  if (opportunity.location) parts.push(opportunity.location);
  if (opportunity.work_mode) parts.push(opportunity.work_mode);
  if (opportunity.employment_type) parts.push(opportunity.employment_type);
  return parts.join(" · ");
}
