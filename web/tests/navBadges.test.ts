import { describe, it, expect } from "vitest";
import { todayBadgeCount, feedBadgeCount } from "../src/lib/navBadges.js";
import type { DailyQueueItem, OpportunityFeedItem } from "../src/lib/api.js";

function actionQueueItem(id: string): DailyQueueItem {
  return {
    reason: "action_required",
    id,
    action: {
      application_id: id,
      opportunity_id: `opp-${id}`,
      title: "Backend Intern",
      company: "Acme Corp",
      reason: "deadline_approaching",
      due_date: "2026-03-01",
      days_until_due: 2,
    },
  };
}

function feedItem(id: string, overrides: Partial<OpportunityFeedItem> = {}): OpportunityFeedItem {
  return {
    opportunity_match_id: id,
    opportunity_source_id: `source-${id}`,
    title: "Frontend Intern",
    company: "Nimbus Labs",
    location: null,
    work_mode: null,
    employment_type: "internship",
    posted_date: null,
    application_url: null,
    match_score: 50,
    eligibility_status: "eligible",
    match_reasons: [],
    match_missing: [],
    match_unknown: [],
    inbox_status: "new",
    is_priority: false,
    promoted_opportunity_id: null,
    duplicate_source_count: 0,
    deadline_date: null,
    ...overrides,
  };
}

describe("todayBadgeCount", () => {
  it("returns the queue length when the queue is a real (possibly empty) array", () => {
    expect(todayBadgeCount([actionQueueItem("a1"), actionQueueItem("a2")])).toBe(2);
    expect(todayBadgeCount([])).toBe(0);
  });

  it("returns undefined (no badge) when the queue is unavailable, never 0", () => {
    expect(todayBadgeCount(undefined)).toBeUndefined();
    expect(todayBadgeCount(null)).toBeUndefined();
  });
});

describe("feedBadgeCount", () => {
  it("counts only untriaged, not-yet-promoted, non-ineligible matches", () => {
    const items = [
      feedItem("m1", { inbox_status: "new" }),
      feedItem("m2", { inbox_status: "saved" }),
      feedItem("m3", { inbox_status: "dismissed" }),
      feedItem("m4", { inbox_status: "new", promoted_opportunity_id: "opp-1" }),
      feedItem("m5", { inbox_status: "new", eligibility_status: "ineligible" }),
      feedItem("m6", { inbox_status: "new" }),
    ];
    expect(feedBadgeCount(items)).toBe(2); // only m1 and m6
  });

  it("returns 0 for an empty items list", () => {
    expect(feedBadgeCount([])).toBe(0);
  });

  it("matches the same definition as backend todayView.ts's summarizeItems() actionable-new-matches formula", () => {
    // Mirrors the exact fixture semantics from api/tests/todayView.test.ts
    // (eligibility_status !== "ineligible" && promoted_opportunity_id === null
    // && inbox_status === "new") — a change to this formula here without a
    // matching backend change (or vice versa) would make the Feed nav badge
    // and Today's feed_summary.new_matches_count silently disagree.
    const items = [
      feedItem("eligible-new", { eligibility_status: "eligible", inbox_status: "new" }),
      feedItem("unknown-new", { eligibility_status: "unknown", inbox_status: "new" }),
      feedItem("ineligible-new", { eligibility_status: "ineligible", inbox_status: "new" }),
    ];
    expect(feedBadgeCount(items)).toBe(2);
  });
});
