import { describe, it, expect } from "vitest";
import { buildOpportunityFeed } from "../src/lib/opportunityFeed.js";
import type { OpportunityMatchRow, OpportunitySourceRow } from "../src/lib/opportunityFeed.js";

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

describe("buildOpportunityFeed", () => {
  it("joins match/source rows correctly", () => {
    const items = buildOpportunityFeed(
      [matchRow({ id: "m1", opportunity_source_id: "s1", match_score: 70 })],
      [sourceRow({ id: "s1", title: "Backend Intern", company: "Nimbus" })]
    );

    expect(items).toHaveLength(1);
    expect(items[0].opportunity_match_id).toBe("m1");
    expect(items[0].opportunity_source_id).toBe("s1");
    expect(items[0].title).toBe("Backend Intern");
    expect(items[0].company).toBe("Nimbus");
    expect(items[0].match_score).toBe(70);
  });

  it("sorts by match_score descending", () => {
    const items = buildOpportunityFeed(
      [
        matchRow({ id: "m-low", opportunity_source_id: "s1", match_score: 30 }),
        matchRow({ id: "m-high", opportunity_source_id: "s2", match_score: 90 }),
        matchRow({ id: "m-mid", opportunity_source_id: "s3", match_score: 60 }),
      ],
      [sourceRow({ id: "s1" }), sourceRow({ id: "s2" }), sourceRow({ id: "s3" })]
    );

    expect(items.map((i) => i.opportunity_match_id)).toEqual(["m-high", "m-mid", "m-low"]);
  });

  it("sorts by posted_date descending when match_score is equal, nulls last", () => {
    const items = buildOpportunityFeed(
      [
        matchRow({ id: "m-null", opportunity_source_id: "s-null", match_score: 50 }),
        matchRow({ id: "m-old", opportunity_source_id: "s-old", match_score: 50 }),
        matchRow({ id: "m-new", opportunity_source_id: "s-new", match_score: 50 }),
      ],
      [
        sourceRow({ id: "s-null", posted_date: null }),
        sourceRow({ id: "s-old", posted_date: "2026-01-01" }),
        sourceRow({ id: "s-new", posted_date: "2026-08-01" }),
      ]
    );

    expect(items.map((i) => i.opportunity_match_id)).toEqual(["m-new", "m-old", "m-null"]);
  });

  it("uses opportunity_source_id ascending as a deterministic tie-breaker", () => {
    const items = buildOpportunityFeed(
      [
        matchRow({ id: "m-b", opportunity_source_id: "source-b", match_score: 50 }),
        matchRow({ id: "m-a", opportunity_source_id: "source-a", match_score: 50 }),
      ],
      [
        sourceRow({ id: "source-b", posted_date: "2026-08-01" }),
        sourceRow({ id: "source-a", posted_date: "2026-08-01" }),
      ]
    );

    expect(items.map((i) => i.opportunity_source_id)).toEqual(["source-a", "source-b"]);
  });

  it("drops a match whose opportunity_source_id has no corresponding source row, without throwing", () => {
    const items = buildOpportunityFeed([matchRow({ opportunity_source_id: "does-not-exist" })], [sourceRow({ id: "source-1" })]);

    expect(items).toEqual([]);
  });

  it("drops a match whose source row exists but is not active", () => {
    const items = buildOpportunityFeed(
      [matchRow({ opportunity_source_id: "s1" })],
      [sourceRow({ id: "s1", status: "expired" })]
    );

    expect(items).toEqual([]);
  });

  it("returns an empty feed for empty inputs", () => {
    expect(buildOpportunityFeed([], [])).toEqual([]);
  });

  it("safely produces empty reason/missing/unknown arrays when match_breakdown is malformed or missing", () => {
    const malformedCases: unknown[] = [null, undefined, "not an object", 42, [], { reasons: "not an array" }];

    for (const malformed of malformedCases) {
      const items = buildOpportunityFeed(
        [matchRow({ match_breakdown: malformed })],
        [sourceRow({ id: "source-1" })]
      );
      expect(items[0].match_reasons).toEqual([]);
      expect(items[0].match_missing).toEqual([]);
      expect(items[0].match_unknown).toEqual([]);
    }
  });

  it("extracts reasons/missing/unknown from a well-formed match_breakdown", () => {
    const items = buildOpportunityFeed(
      [
        matchRow({
          match_breakdown: {
            breakdown: { skills: 40, education: 20, experience: 0, projects: 0 },
            reasons: ["Skill match: python"],
            missing: ["Requires bachelor's degree"],
            unknown: ["No sponsorship information stated"],
          },
        }),
      ],
      [sourceRow({ id: "source-1" })]
    );

    expect(items[0].match_reasons).toEqual(["Skill match: python"]);
    expect(items[0].match_missing).toEqual(["Requires bachelor's degree"]);
    expect(items[0].match_unknown).toEqual(["No sponsorship information stated"]);
  });

  it("keeps eligibility_status as 'unknown' unchanged — never inferred or altered by the builder", () => {
    const items = buildOpportunityFeed(
      [matchRow({ eligibility_status: "unknown" })],
      [sourceRow({ id: "source-1" })]
    );

    expect(items[0].eligibility_status).toBe("unknown");
  });

  it("never recomputes match_score — passes it through exactly as given", () => {
    const items = buildOpportunityFeed([matchRow({ match_score: 37.5 })], [sourceRow({ id: "source-1" })]);
    expect(items[0].match_score).toBe(37.5);
  });

  it("passes promoted_opportunity_id through unchanged — null when not yet applied, the id once it is", () => {
    const untouched = buildOpportunityFeed([matchRow()], [sourceRow({ id: "source-1" })]);
    expect(untouched[0].promoted_opportunity_id).toBeNull();

    const applied = buildOpportunityFeed(
      [matchRow({ promoted_opportunity_id: "app-opp-1" })],
      [sourceRow({ id: "source-1" })]
    );
    expect(applied[0].promoted_opportunity_id).toBe("app-opp-1");
  });
});
