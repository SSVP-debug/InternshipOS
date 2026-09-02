import { describe, it, expect } from "vitest";
import { buildTodayView, type ApplicationRow, type OpportunityRow } from "../src/lib/todayView.js";
import type { OpportunityFeedItem } from "../src/lib/opportunityFeed.js";

const NOW = new Date("2026-02-10T12:00:00Z"); // fixed "today" = 2026-02-10

function opp(overrides: Partial<OpportunityRow> & { id: string }): OpportunityRow {
  return {
    title: "Intern Role",
    company: "Acme Corp",
    application_url: "https://acme.example/careers",
    deadline_date: null,
    inbox_status: "new",
    is_priority: false,
    ...overrides,
  };
}

function app(overrides: Partial<ApplicationRow> & { id: string; opportunity_id: string }): ApplicationRow {
  return {
    status: "SAVED",
    applied_at: null,
    deadline_override: null,
    next_action_date: null,
    next_action_note: null,
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

describe("buildTodayView — empty state", () => {
  it("returns an empty-but-well-formed view with no applications or opportunities", () => {
    const view = buildTodayView({ applications: [], opportunities: [], now: NOW });
    expect(view.action_required).toEqual([]);
    expect(view.deadlines_approaching).toEqual([]);
    expect(view.follow_ups_due).toEqual([]);
    expect(view.saved_opportunities).toEqual([]);
    expect(view.recently_applied).toEqual([]);
    expect(view.stats.total_applications).toBe(0);
    expect(view.pipeline_summary.SAVED).toBe(0);
  });
});

describe("buildTodayView — deadlines approaching", () => {
  it("surfaces a SAVED application's opportunity deadline within 14 days under deadlines_approaching", () => {
    const opportunities = [opp({ id: "o1", deadline_date: "2026-02-20" })]; // 10 days out
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "SAVED" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.deadlines_approaching).toHaveLength(1);
    expect(view.deadlines_approaching[0].days_until_due).toBe(10);
  });

  it("excludes a deadline more than 14 days out", () => {
    const opportunities = [opp({ id: "o1", deadline_date: "2026-03-15" })]; // 33 days out
    const applications = [app({ id: "a1", opportunity_id: "o1" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.deadlines_approaching).toHaveLength(0);
  });

  it("prefers deadline_override over the opportunity's own deadline_date", () => {
    const opportunities = [opp({ id: "o1", deadline_date: "2026-03-01" })];
    const applications = [app({ id: "a1", opportunity_id: "o1", deadline_override: "2026-02-12" })]; // 2 days out
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.deadlines_approaching[0].due_date).toBe("2026-02-12");
    expect(view.deadlines_approaching[0].days_until_due).toBe(2);
  });

  it("excludes deadlines for REJECTED/WITHDRAWN applications (inactive, no longer needs attention)", () => {
    const opportunities = [opp({ id: "o1", deadline_date: "2026-02-12" })];
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "WITHDRAWN" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.deadlines_approaching).toHaveLength(0);
  });

  it("sorts deadlines_approaching soonest-first", () => {
    const opportunities = [
      opp({ id: "o1", deadline_date: "2026-02-22" }),
      opp({ id: "o2", deadline_date: "2026-02-11" }),
    ];
    const applications = [
      app({ id: "a1", opportunity_id: "o1" }),
      app({ id: "a2", opportunity_id: "o2" }),
    ];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.deadlines_approaching.map((d) => d.opportunity_id)).toEqual(["o2", "o1"]);
  });
});

describe("buildTodayView — action_required", () => {
  it("includes a pre-apply application (SAVED/APPLYING) with a deadline within 3 days", () => {
    const opportunities = [opp({ id: "o1", deadline_date: "2026-02-12" })]; // 2 days out
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "APPLYING" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.action_required.some((a) => a.application_id === "a1" && a.reason === "deadline_approaching")).toBe(
      true,
    );
  });

  it("does NOT include an already-APPLIED application's looming deadline in action_required (nothing left to act on for that reason)", () => {
    const opportunities = [opp({ id: "o1", deadline_date: "2026-02-12" })];
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "APPLIED", applied_at: "2026-02-05T00:00:00Z" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.action_required.some((a) => a.reason === "deadline_approaching")).toBe(false);
    // but it should still show up in deadlines_approaching for visibility
    expect(view.deadlines_approaching).toHaveLength(1);
  });

  it("excludes a pre-apply deadline further than 3 days out from action_required, even though it's within deadlines_approaching", () => {
    const opportunities = [opp({ id: "o1", deadline_date: "2026-02-17" })]; // 7 days out
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "SAVED" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.deadlines_approaching).toHaveLength(1);
    expect(view.action_required).toHaveLength(0);
  });
});

describe("buildTodayView — follow-ups", () => {
  it("surfaces a follow-up due today", () => {
    const opportunities = [opp({ id: "o1" })];
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "APPLIED", next_action_date: "2026-02-10" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.follow_ups_due).toHaveLength(1);
    expect(view.follow_ups_due[0].reason).toBe("follow_up_due");
    expect(view.stats.overdue_follow_ups_count).toBe(0);
  });

  it("surfaces an overdue follow-up and counts it in stats", () => {
    const opportunities = [opp({ id: "o1" })];
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "APPLIED", next_action_date: "2026-02-01" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.follow_ups_due).toHaveLength(1);
    expect(view.follow_ups_due[0].reason).toBe("follow_up_overdue");
    expect(view.stats.overdue_follow_ups_count).toBe(1);
  });

  it("does not surface a future follow-up (not due yet)", () => {
    const opportunities = [opp({ id: "o1" })];
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "APPLIED", next_action_date: "2026-02-15" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.follow_ups_due).toHaveLength(0);
  });

  it("every follow-up due/overdue item also appears in action_required", () => {
    const opportunities = [opp({ id: "o1" })];
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "INTERVIEW", next_action_date: "2026-02-01" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.action_required.some((a) => a.application_id === "a1" && a.reason === "follow_up_overdue")).toBe(
      true,
    );
  });

  it("does not surface follow-ups for WITHDRAWN/REJECTED applications", () => {
    const opportunities = [opp({ id: "o1" })];
    const applications = [
      app({ id: "a1", opportunity_id: "o1", status: "REJECTED", next_action_date: "2026-02-01" }),
    ];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.follow_ups_due).toHaveLength(0);
  });
});

describe("buildTodayView — recently applied", () => {
  it("includes an application applied within the last 7 days", () => {
    const opportunities = [opp({ id: "o1" })];
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "APPLIED", applied_at: "2026-02-05T00:00:00Z" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.recently_applied).toHaveLength(1);
  });

  it("excludes an application applied more than 7 days ago", () => {
    const opportunities = [opp({ id: "o1" })];
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "APPLIED", applied_at: "2026-01-01T00:00:00Z" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.recently_applied).toHaveLength(0);
  });

  it("excludes an application that was never applied to (applied_at null)", () => {
    const opportunities = [opp({ id: "o1" })];
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "SAVED", applied_at: null })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.recently_applied).toHaveLength(0);
  });
});

describe("buildTodayView — saved opportunities & triage", () => {
  it("lists saved opportunities that do not yet have an application", () => {
    const opportunities = [opp({ id: "o1", inbox_status: "saved" }), opp({ id: "o2", inbox_status: "new" })];
    const view = buildTodayView({ applications: [], opportunities, now: NOW });
    expect(view.saved_opportunities.map((o) => o.opportunity_id)).toEqual(["o1"]);
  });

  it("excludes a saved opportunity once it has an application (application, not the inbox, is now the source of truth)", () => {
    const opportunities = [opp({ id: "o1", inbox_status: "saved" })];
    const applications = [app({ id: "a1", opportunity_id: "o1" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.saved_opportunities).toHaveLength(0);
  });

  it("counts opportunities needing triage (inbox_status = new)", () => {
    const opportunities = [opp({ id: "o1", inbox_status: "new" }), opp({ id: "o2", inbox_status: "new" }), opp({ id: "o3", inbox_status: "dismissed" })];
    const view = buildTodayView({ applications: [], opportunities, now: NOW });
    expect(view.stats.opportunities_needing_triage).toBe(2);
  });

  it("ranks priority-flagged saved opportunities first, then by soonest deadline", () => {
    const opportunities = [
      opp({ id: "o1", inbox_status: "saved", is_priority: false, deadline_date: "2026-02-11" }),
      opp({ id: "o2", inbox_status: "saved", is_priority: true, deadline_date: "2026-03-01" }),
    ];
    const view = buildTodayView({ applications: [], opportunities, now: NOW });
    expect(view.saved_opportunities[0].opportunity_id).toBe("o2");
  });

  it("caps saved_opportunities at 5", () => {
    const opportunities = Array.from({ length: 8 }, (_, i) => opp({ id: `o${i}`, inbox_status: "saved" }));
    const view = buildTodayView({ applications: [], opportunities, now: NOW });
    expect(view.saved_opportunities).toHaveLength(5);
  });
});

describe("buildTodayView — pipeline summary", () => {
  it("counts every status, including zero-count statuses", () => {
    const opportunities = [opp({ id: "o1" }), opp({ id: "o2" })];
    const applications = [
      app({ id: "a1", opportunity_id: "o1", status: "APPLIED" }),
      app({ id: "a2", opportunity_id: "o2", status: "APPLIED" }),
    ];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.pipeline_summary.APPLIED).toBe(2);
    expect(view.pipeline_summary.OFFER).toBe(0);
    expect(view.pipeline_summary.SAVED).toBe(0);
  });

  it("includes terminal statuses in pipeline_summary even though they're excluded from action surfaces", () => {
    const opportunities = [opp({ id: "o1" })];
    const applications = [app({ id: "a1", opportunity_id: "o1", status: "REJECTED" })];
    const view = buildTodayView({ applications, opportunities, now: NOW });
    expect(view.pipeline_summary.REJECTED).toBe(1);
    expect(view.stats.active_applications).toBe(0);
    expect(view.stats.total_applications).toBe(1);
  });
});

describe("buildTodayView — resilience to missing opportunity data", () => {
  it("does not throw when an application references an opportunity_id not present in the opportunities array", () => {
    const applications = [app({ id: "a1", opportunity_id: "does-not-exist", status: "APPLIED", next_action_date: "2026-02-01" })];
    expect(() => buildTodayView({ applications, opportunities: [], now: NOW })).not.toThrow();
    const view = buildTodayView({ applications, opportunities: [], now: NOW });
    expect(view.follow_ups_due[0].title).toContain("no longer available");
  });
});

describe("buildTodayView — feed_summary", () => {
  function feedItem(overrides: Partial<OpportunityFeedItem> & { opportunity_match_id: string }): OpportunityFeedItem {
    return {
      opportunity_source_id: "source-1",
      title: "Backend Engineering Intern",
      company: "Nimbus Labs",
      location: "Remote",
      work_mode: "remote",
      employment_type: "internship",
      posted_date: "2026-02-01",
      application_url: "https://example.com/apply",
      match_score: 80,
      eligibility_status: "unknown",
      match_reasons: [],
      match_missing: [],
      match_unknown: [],
      inbox_status: "new",
      is_priority: false,
      promoted_opportunity_id: null,
      duplicate_source_count: 0,
      ...overrides,
    };
  }

  it("defaults to an empty feed_summary when feedItems is omitted entirely", () => {
    const view = buildTodayView({ applications: [], opportunities: [], now: NOW });
    expect(view.feed_summary).toEqual({
      new_matches_count: 0,
      top_matches: [],
      last_ingested_at: null,
      resume_highlights: [],
    });
  });

  it("counts only 'new' inbox_status matches toward new_matches_count", () => {
    const feedItems = [
      feedItem({ opportunity_match_id: "m1", inbox_status: "new" }),
      feedItem({ opportunity_match_id: "m2", inbox_status: "saved" }),
      feedItem({ opportunity_match_id: "m3", inbox_status: "dismissed" }),
    ];
    const view = buildTodayView({ applications: [], opportunities: [], feedItems, now: NOW });
    expect(view.feed_summary.new_matches_count).toBe(1);
  });

  it("excludes ineligible matches from both new_matches_count and top_matches", () => {
    const feedItems = [
      feedItem({ opportunity_match_id: "m1", inbox_status: "new", eligibility_status: "ineligible" }),
      feedItem({ opportunity_match_id: "m2", inbox_status: "new", eligibility_status: "eligible" }),
    ];
    const view = buildTodayView({ applications: [], opportunities: [], feedItems, now: NOW });
    expect(view.feed_summary.new_matches_count).toBe(1);
    expect(view.feed_summary.top_matches.map((m) => m.opportunity_match_id)).toEqual(["m2"]);
  });

  it("excludes already-promoted matches — a candidate who already applied doesn't need to be told about it again", () => {
    const feedItems = [
      feedItem({ opportunity_match_id: "m1", inbox_status: "new", promoted_opportunity_id: "opp-applied-1" }),
      feedItem({ opportunity_match_id: "m2", inbox_status: "new", promoted_opportunity_id: null }),
    ];
    const view = buildTodayView({ applications: [], opportunities: [], feedItems, now: NOW });
    expect(view.feed_summary.new_matches_count).toBe(1);
    expect(view.feed_summary.top_matches.map((m) => m.opportunity_match_id)).toEqual(["m2"]);
  });

  it("caps top_matches at 3 and relies on feedItems already being sorted (does not re-sort)", () => {
    const feedItems = [
      feedItem({ opportunity_match_id: "m1", match_score: 90 }),
      feedItem({ opportunity_match_id: "m2", match_score: 80 }),
      feedItem({ opportunity_match_id: "m3", match_score: 70 }),
      feedItem({ opportunity_match_id: "m4", match_score: 60 }),
    ];
    const view = buildTodayView({ applications: [], opportunities: [], feedItems, now: NOW });
    expect(view.feed_summary.top_matches).toHaveLength(3);
    expect(view.feed_summary.top_matches.map((m) => m.opportunity_match_id)).toEqual(["m1", "m2", "m3"]);
  });

  it("top_matches carries only the fields a dashboard highlight needs, not the full feed item shape", () => {
    const feedItems = [feedItem({ opportunity_match_id: "m1", title: "Data Intern", company: "Zeta Labs", match_score: 55 })];
    const view = buildTodayView({ applications: [], opportunities: [], feedItems, now: NOW });
    expect(view.feed_summary.top_matches[0]).toEqual({
      opportunity_match_id: "m1",
      title: "Data Intern",
      company: "Zeta Labs",
      match_score: 55,
      eligibility_status: "unknown",
    });
  });

  it("defaults last_ingested_at to null when the caller omits it entirely", () => {
    const view = buildTodayView({ applications: [], opportunities: [], now: NOW });
    expect(view.feed_summary.last_ingested_at).toBeNull();
  });

  it("passes lastIngestedAt through unchanged — not recomputed from feedItems", () => {
    const view = buildTodayView({
      applications: [],
      opportunities: [],
      feedItems: [feedItem({ opportunity_match_id: "m1" })],
      lastIngestedAt: "2026-08-29T09:00:00Z",
      now: NOW,
    });
    expect(view.feed_summary.last_ingested_at).toBe("2026-08-29T09:00:00Z");
  });

  it("an explicit null lastIngestedAt (ingestion has never run) is preserved, not silently swapped for a default", () => {
    const view = buildTodayView({ applications: [], opportunities: [], lastIngestedAt: null, now: NOW });
    expect(view.feed_summary.last_ingested_at).toBeNull();
  });

  // ── Gate R3: resume_highlights ─────────────────────────────────────

  it("Gate R3: defaults resume_highlights to [] when resumeFeedGroups is omitted — unchanged payload for candidates with no resumes", () => {
    const view = buildTodayView({
      applications: [],
      opportunities: [],
      feedItems: [feedItem({ opportunity_match_id: "m1" })],
      now: NOW,
    });
    expect(view.feed_summary.resume_highlights).toEqual([]);
  });

  it("Gate R3: one resume_highlights entry per resume group, applying the SAME actionable/new-count rules as the flat feed", () => {
    const view = buildTodayView({
      applications: [],
      opportunities: [],
      feedItems: [],
      resumeFeedGroups: [
        {
          resumeId: "resume-1",
          label: "Software Development",
          targetRoleCategory: "Software Engineering",
          items: [
            feedItem({ opportunity_match_id: "r1-m1", inbox_status: "new" }),
            feedItem({ opportunity_match_id: "r1-m2", inbox_status: "saved" }),
            // Ineligible and already-promoted matches must be excluded
            // here exactly like they are in the flat feed — same
            // summarizeItems() call underneath, not a re-implementation.
            feedItem({ opportunity_match_id: "r1-m3", eligibility_status: "ineligible" }),
            feedItem({ opportunity_match_id: "r1-m4", promoted_opportunity_id: "app-1" }),
          ],
        },
      ],
      now: NOW,
    });

    expect(view.feed_summary.resume_highlights).toEqual([
      {
        resume_id: "resume-1",
        label: "Software Development",
        target_role_category: "Software Engineering",
        new_matches_count: 1,
        top_matches: [
          expect.objectContaining({ opportunity_match_id: "r1-m1" }),
          expect.objectContaining({ opportunity_match_id: "r1-m2" }),
        ],
      },
    ]);
  });

  it("Gate R3: a resume with zero current matches still gets an entry (new_matches_count: 0, top_matches: []), not omitted", () => {
    const view = buildTodayView({
      applications: [],
      opportunities: [],
      feedItems: [],
      resumeFeedGroups: [{ resumeId: "resume-empty", label: "AI/ML", targetRoleCategory: null, items: [] }],
      now: NOW,
    });

    expect(view.feed_summary.resume_highlights).toEqual([
      { resume_id: "resume-empty", label: "AI/ML", target_role_category: null, new_matches_count: 0, top_matches: [] },
    ]);
  });

  it("Gate R3: multiple resumes each get their own independent highlight, in the order given", () => {
    const view = buildTodayView({
      applications: [],
      opportunities: [],
      feedItems: [feedItem({ opportunity_match_id: "flat-m1" })], // flat feed is untouched by resume groups
      resumeFeedGroups: [
        {
          resumeId: "resume-a",
          label: "Software Development",
          targetRoleCategory: null,
          items: [feedItem({ opportunity_match_id: "a-m1", inbox_status: "new" })],
        },
        {
          resumeId: "resume-b",
          label: "Data Science",
          targetRoleCategory: null,
          items: [
            feedItem({ opportunity_match_id: "b-m1", inbox_status: "new" }),
            feedItem({ opportunity_match_id: "b-m2", inbox_status: "new" }),
          ],
        },
      ],
      now: NOW,
    });

    expect(view.feed_summary.new_matches_count).toBe(1); // flat feed unaffected
    expect(view.feed_summary.resume_highlights.map((h) => [h.resume_id, h.new_matches_count])).toEqual([
      ["resume-a", 1],
      ["resume-b", 2],
    ]);
  });
});
