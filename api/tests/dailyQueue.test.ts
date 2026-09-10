import { describe, it, expect } from "vitest";
import { buildDailyQueue, DAILY_QUEUE_CAP, type DailyQueueOpportunityItem, type DailyQueueActionItem } from "../src/lib/dailyQueue.js";
import type { TodayActionItem } from "../src/lib/todayView.js";
import type { OpportunityMatchRow, OpportunitySourceRow } from "../src/lib/opportunityFeed.js";

function actionItem(overrides: Partial<TodayActionItem> & { application_id: string }): TodayActionItem {
  return {
    opportunity_id: `opp-for-${overrides.application_id}`,
    title: "Intern Role",
    company: "Acme Corp",
    reason: "deadline_approaching",
    due_date: "2026-02-12",
    days_until_due: 2,
    ...overrides,
  };
}

function matchRow(overrides: Partial<OpportunityMatchRow> = {}): OpportunityMatchRow {
  return {
    id: "match-1",
    opportunity_source_id: "source-1",
    match_score: 50,
    eligibility_status: "unknown",
    match_breakdown: { breakdown: {}, reasons: [], missing: [], unknown: [] },
    inbox_status: "new",
    is_priority: false,
    promoted_opportunity_id: null,
    ...overrides,
  };
}

function sourceRow(overrides: Partial<OpportunitySourceRow> = {}): OpportunitySourceRow {
  return {
    id: "source-1",
    title: "Software Engineering Intern",
    company: "Acme Corp",
    location: "Bengaluru, India",
    work_mode: "hybrid",
    employment_type: "internship",
    posted_date: "2026-08-01",
    application_url: "https://example.com/apply",
    status: "active",
    ...overrides,
  };
}

function isAction(item: { reason: string }): item is DailyQueueActionItem {
  return item.reason === "action_required";
}

function isMatch(item: { reason: string }): item is DailyQueueOpportunityItem {
  return item.reason === "match";
}

describe("buildDailyQueue — empty input", () => {
  it("returns [] when there are no action-required items and no eligible matches", () => {
    const queue = buildDailyQueue({ actionRequired: [], matches: [], sources: [] });
    expect(queue).toEqual([]);
  });
});

describe("buildDailyQueue — action-required priority", () => {
  it("orders all action-required items before any opportunity suggestion", () => {
    const actionRequired = [actionItem({ application_id: "a1", days_until_due: 1 })];
    const matches = [matchRow({ id: "m1", match_score: 99 })];
    const sources = [sourceRow({ id: "source-1" })];

    const queue = buildDailyQueue({ actionRequired, matches, sources });

    expect(queue).toHaveLength(2);
    expect(queue[0].reason).toBe("action_required");
    expect(queue[1].reason).toBe("match");
  });
});

describe("buildDailyQueue — opportunity score ordering", () => {
  it("orders eligible opportunities by existing match_score descending", () => {
    const matches = [
      matchRow({ id: "m-low", opportunity_source_id: "s1", match_score: 20 }),
      matchRow({ id: "m-high", opportunity_source_id: "s2", match_score: 80 }),
      matchRow({ id: "m-mid", opportunity_source_id: "s3", match_score: 50 }),
    ];
    const sources = [
      sourceRow({ id: "s1", title: "Low Match", company: "Low Co" }),
      sourceRow({ id: "s2", title: "High Match", company: "High Co" }),
      sourceRow({ id: "s3", title: "Mid Match", company: "Mid Co" }),
    ];

    const queue = buildDailyQueue({ actionRequired: [], matches, sources }).filter(isMatch);

    expect(queue.map((q) => q.opportunity.opportunity_match_id)).toEqual(["m-high", "m-mid", "m-low"]);
  });
});

describe("buildDailyQueue — queue cap", () => {
  it("caps the queue at DAILY_QUEUE_CAP (5), keeping action-required items first", () => {
    const actionRequired = [
      actionItem({ application_id: "a1", days_until_due: 3 }),
      actionItem({ application_id: "a2", days_until_due: 1 }),
      actionItem({ application_id: "a3", days_until_due: -1 }),
    ];
    // 4 eligible matches, distinct scores.
    const matches = [10, 20, 30, 40].map((score, i) =>
      matchRow({ id: `m${i}`, opportunity_source_id: `s${i}`, match_score: score }),
    );
    const sources = [0, 1, 2, 3].map((i) =>
      sourceRow({ id: `s${i}`, title: `Role ${i}`, company: `Company ${i}` }),
    );

    const queue = buildDailyQueue({ actionRequired, matches, sources });

    expect(queue).toHaveLength(DAILY_QUEUE_CAP);
    // All 3 action-required items survive (highest priority), then the
    // top 2 opportunities by score fill the remaining 2 slots.
    const actions = queue.filter(isAction).map((q) => q.action.application_id);
    const opportunities = queue.filter(isMatch).map((q) => q.opportunity.opportunity_match_id);
    expect(actions.sort()).toEqual(["a1", "a2", "a3"]);
    expect(opportunities).toEqual(["m3", "m2"]); // scores 40, 30 — the two highest
  });

  it("truncates action-required items themselves (by urgency) if there are more than the cap", () => {
    const actionRequired = [1, 2, 3, 4, 5, 6, 7].map((days, i) =>
      actionItem({ application_id: `a${i}`, days_until_due: 7 - days }),
    );
    const queue = buildDailyQueue({ actionRequired, matches: [], sources: [] });

    expect(queue).toHaveLength(DAILY_QUEUE_CAP);
    expect(queue.every(isAction)).toBe(true);
    // Most urgent (smallest days_until_due) items must survive.
    const survivingDays = queue.filter(isAction).map((q) => q.action.days_until_due);
    expect(survivingDays).toEqual([...survivingDays].sort((a, b) => a - b));
  });
});

describe("buildDailyQueue — untriaged filtering", () => {
  it("excludes matches with inbox_status 'saved'", () => {
    const matches = [matchRow({ id: "m1", inbox_status: "saved" })];
    const sources = [sourceRow({ id: "source-1" })];
    const queue = buildDailyQueue({ actionRequired: [], matches, sources });
    expect(queue).toEqual([]);
  });

  it("excludes matches with inbox_status 'dismissed'", () => {
    const matches = [matchRow({ id: "m1", inbox_status: "dismissed" })];
    const sources = [sourceRow({ id: "source-1" })];
    const queue = buildDailyQueue({ actionRequired: [], matches, sources });
    expect(queue).toEqual([]);
  });

  it("excludes matches that are already promoted into a tracked opportunity", () => {
    const matches = [matchRow({ id: "m1", inbox_status: "new", promoted_opportunity_id: "opp-1" })];
    const sources = [sourceRow({ id: "source-1" })];
    const queue = buildDailyQueue({ actionRequired: [], matches, sources });
    expect(queue).toEqual([]);
  });
});

describe("buildDailyQueue — expired filtering", () => {
  it("excludes matches whose opportunity_source is no longer active, without altering expiry behavior", () => {
    const matches = [matchRow({ id: "m1", opportunity_source_id: "s1" })];
    const sources = [sourceRow({ id: "s1", status: "expired" })];
    const queue = buildDailyQueue({ actionRequired: [], matches, sources });
    expect(queue).toEqual([]);
  });

  it("excludes matches whose opportunity_source has been removed", () => {
    const matches = [matchRow({ id: "m1", opportunity_source_id: "s1" })];
    const sources = [sourceRow({ id: "s1", status: "removed" })];
    const queue = buildDailyQueue({ actionRequired: [], matches, sources });
    expect(queue).toEqual([]);
  });
});

describe("buildDailyQueue — match-score floor", () => {
  it("excludes an untriaged match at an exact-zero score (existing A3.1 floor), unmodified", () => {
    const matches = [matchRow({ id: "m1", match_score: 0, inbox_status: "new" })];
    const sources = [sourceRow({ id: "source-1" })];
    const queue = buildDailyQueue({ actionRequired: [], matches, sources });
    expect(queue).toEqual([]);
  });

  it("includes an untriaged match right at the floor (score 1)", () => {
    const matches = [matchRow({ id: "m1", match_score: 1, inbox_status: "new" })];
    const sources = [sourceRow({ id: "source-1" })];
    const queue = buildDailyQueue({ actionRequired: [], matches, sources });
    expect(queue).toHaveLength(1);
  });
});

describe("buildDailyQueue — deduplication", () => {
  it("does not surface the same underlying opportunity through both inputs", () => {
    // Edge case: a match row that is (incorrectly, or via a race) still
    // inbox_status "new" but already carries a promoted_opportunity_id
    // that an action_required item also covers. The queue must not show
    // both — the tracked application (action_required) wins, and the
    // stale/inconsistent match entry is suppressed.
    const actionRequired = [actionItem({ application_id: "a1", opportunity_id: "opp-1", days_until_due: 2 })];
    const matches = [
      matchRow({ id: "m1", opportunity_source_id: "s1", inbox_status: "new", promoted_opportunity_id: "opp-1" }),
    ];
    const sources = [sourceRow({ id: "s1" })];

    const queue = buildDailyQueue({ actionRequired, matches, sources });

    expect(queue).toHaveLength(1);
    expect(queue[0].reason).toBe("action_required");
  });

  it("does not duplicate an action-required item if it somehow appears twice in input", () => {
    const actionRequired = [
      actionItem({ application_id: "a1", days_until_due: 1 }),
      actionItem({ application_id: "a1", days_until_due: 1 }),
    ];
    const queue = buildDailyQueue({ actionRequired, matches: [], sources: [] });
    expect(queue).toHaveLength(1);
  });
});

describe("buildDailyQueue — deterministic ordering", () => {
  it("breaks ties between equal-urgency action items by application_id ascending", () => {
    const actionRequired = [
      actionItem({ application_id: "a2", days_until_due: 1 }),
      actionItem({ application_id: "a1", days_until_due: 1 }),
    ];
    const queue = buildDailyQueue({ actionRequired, matches: [], sources: [] }).filter(isAction);
    expect(queue.map((q) => q.action.application_id)).toEqual(["a1", "a2"]);
  });

  it("breaks ties between equal-score matches by opportunity_source_id ascending", () => {
    const matches = [
      matchRow({ id: "m-b", opportunity_source_id: "s2", match_score: 50 }),
      matchRow({ id: "m-a", opportunity_source_id: "s1", match_score: 50 }),
    ];
    const sources = [
      sourceRow({ id: "s1", title: "Role A", company: "A Co" }),
      sourceRow({ id: "s2", title: "Role B", company: "B Co" }),
    ];
    const queue = buildDailyQueue({ actionRequired: [], matches, sources }).filter(isMatch);
    expect(queue.map((q) => q.opportunity.opportunity_source_id)).toEqual(["s1", "s2"]);
  });

  it("produces the same output order on repeated calls with the same input", () => {
    const actionRequired = [
      actionItem({ application_id: "a1", days_until_due: 3 }),
      actionItem({ application_id: "a2", days_until_due: 1 }),
    ];
    const matches = [
      matchRow({ id: "m1", opportunity_source_id: "s1", match_score: 40 }),
      matchRow({ id: "m2", opportunity_source_id: "s2", match_score: 90 }),
    ];
    const sources = [sourceRow({ id: "s1" }), sourceRow({ id: "s2", title: "Other Role", company: "Other Co" })];

    const first = buildDailyQueue({ actionRequired, matches, sources });
    const second = buildDailyQueue({ actionRequired, matches, sources });
    expect(first.map((q) => q.id)).toEqual(second.map((q) => q.id));
  });
});

describe("buildDailyQueue — explainable reason", () => {
  it("tags action-required items with reason 'action_required' and their full action payload", () => {
    const actionRequired = [actionItem({ application_id: "a1", reason: "follow_up_overdue", days_until_due: -2 })];
    const queue = buildDailyQueue({ actionRequired, matches: [], sources: [] });
    expect(queue[0].reason).toBe("action_required");
    const item = queue[0] as DailyQueueActionItem;
    expect(item.action.reason).toBe("follow_up_overdue");
    expect(item.action.application_id).toBe("a1");
  });

  it("tags opportunity items with reason 'match' and their full feed payload (including match_score)", () => {
    const matches = [matchRow({ id: "m1", match_score: 77 })];
    const sources = [sourceRow({ id: "source-1" })];
    const queue = buildDailyQueue({ actionRequired: [], matches, sources });
    expect(queue[0].reason).toBe("match");
    const item = queue[0] as DailyQueueOpportunityItem;
    expect(item.opportunity.match_score).toBe(77);
    expect(item.opportunity.opportunity_match_id).toBe("m1");
  });
});
