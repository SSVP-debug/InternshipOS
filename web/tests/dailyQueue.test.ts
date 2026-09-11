import { describe, it, expect } from "vitest";
import { classifyDailyQueueState, dailyQueueItemKey, formatMatchMeta } from "../src/lib/dailyQueue.js";
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

function matchQueueItem(id: string, overrides: Partial<OpportunityFeedItem> = {}): Extract<DailyQueueItem, { reason: "match" }> {
  return {
    reason: "match",
    id,
    opportunity: {
      opportunity_match_id: id,
      opportunity_source_id: `source-${id}`,
      title: "Frontend Intern",
      company: "Nimbus Labs",
      location: "Bengaluru, India",
      work_mode: "remote",
      employment_type: "internship",
      posted_date: "2026-02-01",
      application_url: "https://example.com/apply",
      match_score: 82,
      eligibility_status: "eligible",
      match_reasons: [],
      match_missing: [],
      match_unknown: [],
      inbox_status: "new",
      is_priority: false,
      promoted_opportunity_id: null,
      duplicate_source_count: 0,
      ...overrides,
    },
  };
}

describe("classifyDailyQueueState", () => {
  it("returns 'unavailable' for undefined (field missing from an older/mismatched API response)", () => {
    expect(classifyDailyQueueState(undefined)).toBe("unavailable");
  });

  it("returns 'unavailable' for null", () => {
    expect(classifyDailyQueueState(null)).toBe("unavailable");
  });

  it("returns 'unavailable' for a non-array value", () => {
    expect(classifyDailyQueueState("oops" as unknown as DailyQueueItem[])).toBe("unavailable");
  });

  it("returns 'empty' for an actual empty array — never confused with 'unavailable'", () => {
    expect(classifyDailyQueueState([])).toBe("empty");
  });

  it("returns 'items' when at least one item is present", () => {
    expect(classifyDailyQueueState([actionQueueItem("a1")])).toBe("items");
  });
});

describe("dailyQueueItemKey", () => {
  it("produces a distinct key for an action_required item", () => {
    expect(dailyQueueItemKey(actionQueueItem("a1"))).toBe("action_required:a1");
  });

  it("produces a distinct key for a match item", () => {
    expect(dailyQueueItemKey(matchQueueItem("m1"))).toBe("match:m1");
  });

  it("never collides between the two reasons even with the same underlying id", () => {
    expect(dailyQueueItemKey(actionQueueItem("x"))).not.toBe(dailyQueueItemKey(matchQueueItem("x")));
  });
});

describe("dailyQueueItemKey — order preservation", () => {
  it("mapping over the API-provided array preserves its order (no client-side re-sort)", () => {
    const items: DailyQueueItem[] = [matchQueueItem("m2"), actionQueueItem("a1"), matchQueueItem("m1")];
    expect(items.map(dailyQueueItemKey)).toEqual(["match:m2", "action_required:a1", "match:m1"]);
  });
});

describe("formatMatchMeta", () => {
  it("joins company, location, work_mode, employment_type with a middle dot", () => {
    expect(formatMatchMeta(matchQueueItem("m1").opportunity)).toBe(
      "Nimbus Labs · Bengaluru, India · remote · internship",
    );
  });

  it("skips null location/work_mode without leaving stray separators", () => {
    const opp = matchQueueItem("m1", { location: null, work_mode: null }).opportunity;
    expect(formatMatchMeta(opp)).toBe("Nimbus Labs · internship");
  });
});
