import { describe, it, expect } from "vitest";
import { buildOpportunityFeed, normalizeForDedup } from "../src/lib/opportunityFeed.js";
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
      [
        sourceRow({ id: "s1", title: "Frontend Intern", company: "Low Co" }),
        sourceRow({ id: "s2", title: "Backend Intern", company: "High Co" }),
        sourceRow({ id: "s3", title: "Data Intern", company: "Mid Co" }),
      ]
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
        sourceRow({ id: "s-null", title: "Null-date Intern", company: "Null Co", posted_date: null }),
        sourceRow({ id: "s-old", title: "Old Intern", company: "Old Co", posted_date: "2026-01-01" }),
        sourceRow({ id: "s-new", title: "New Intern", company: "New Co", posted_date: "2026-08-01" }),
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
        sourceRow({ id: "source-b", title: "Role B", company: "Company B", posted_date: "2026-08-01" }),
        sourceRow({ id: "source-a", title: "Role A", company: "Company A", posted_date: "2026-08-01" }),
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

  it("a fresh item with no cross-source duplicate has duplicate_source_count 0", () => {
    const items = buildOpportunityFeed([matchRow()], [sourceRow({ id: "source-1" })]);
    expect(items[0].duplicate_source_count).toBe(0);
  });
});

describe("buildOpportunityFeed — cross-source duplicate collapsing", () => {
  it("collapses two sources whose title/company/location all normalize identically, keeping the higher-scoring one", () => {
    const items = buildOpportunityFeed(
      [
        matchRow({ id: "m-adzuna", opportunity_source_id: "adzuna-1", match_score: 60 }),
        matchRow({ id: "m-remoteok", opportunity_source_id: "remoteok-1", match_score: 85 }),
      ],
      [
        sourceRow({ id: "adzuna-1", title: "Backend Engineering Intern", company: "Acme Corp", location: "Remote" }),
        sourceRow({ id: "remoteok-1", title: "Backend Engineering Intern", company: "Acme Corp", location: "Remote" }),
      ]
    );

    expect(items).toHaveLength(1);
    expect(items[0].opportunity_match_id).toBe("m-remoteok"); // higher score survives
    expect(items[0].duplicate_source_count).toBe(1);
  });

  it("is case/whitespace/punctuation insensitive and strips common company suffixes", () => {
    const items = buildOpportunityFeed(
      [
        matchRow({ id: "m1", opportunity_source_id: "s1", match_score: 50 }),
        matchRow({ id: "m2", opportunity_source_id: "s2", match_score: 40 }),
      ],
      [
        sourceRow({ id: "s1", title: "  Backend Engineering Intern  ", company: "Acme Corp, Inc." }),
        sourceRow({ id: "s2", title: "backend engineering intern", company: "ACME CORP" }),
      ]
    );

    expect(items).toHaveLength(1);
    expect(items[0].duplicate_source_count).toBe(1);
  });

  it("does NOT collapse the same title+company in two different locations — conservative by design", () => {
    const items = buildOpportunityFeed(
      [
        matchRow({ id: "m1", opportunity_source_id: "s1", match_score: 50 }),
        matchRow({ id: "m2", opportunity_source_id: "s2", match_score: 50 }),
      ],
      [
        sourceRow({ id: "s1", title: "Backend Engineering Intern", company: "Acme Corp", location: "Bengaluru, India" }),
        sourceRow({ id: "s2", title: "Backend Engineering Intern", company: "Acme Corp", location: "Mumbai, India" }),
      ]
    );

    expect(items).toHaveLength(2);
    expect(items.every((i) => i.duplicate_source_count === 0)).toBe(true);
  });

  it("does NOT collapse two different titles at the same company/location", () => {
    const items = buildOpportunityFeed(
      [
        matchRow({ id: "m1", opportunity_source_id: "s1", match_score: 50 }),
        matchRow({ id: "m2", opportunity_source_id: "s2", match_score: 50 }),
      ],
      [
        sourceRow({ id: "s1", title: "Backend Engineering Intern", company: "Acme Corp" }),
        sourceRow({ id: "s2", title: "Data Science Intern", company: "Acme Corp" }),
      ]
    );

    expect(items).toHaveLength(2);
  });

  it("collapses three-way duplicates down to one item with duplicate_source_count 2", () => {
    const items = buildOpportunityFeed(
      [
        matchRow({ id: "m1", opportunity_source_id: "s1", match_score: 30 }),
        matchRow({ id: "m2", opportunity_source_id: "s2", match_score: 90 }),
        matchRow({ id: "m3", opportunity_source_id: "s3", match_score: 60 }),
      ],
      [
        sourceRow({ id: "s1", title: "Data Intern", company: "Zeta Labs", location: "Remote" }),
        sourceRow({ id: "s2", title: "Data Intern", company: "Zeta Labs", location: "Remote" }),
        sourceRow({ id: "s3", title: "Data Intern", company: "Zeta Labs", location: "Remote" }),
      ]
    );

    expect(items).toHaveLength(1);
    expect(items[0].opportunity_match_id).toBe("m2"); // highest score of the three
    expect(items[0].duplicate_source_count).toBe(2);
  });
});

describe("normalizeForDedup", () => {
  it("lowercases and trims", () => {
    expect(normalizeForDedup("  Backend Intern  ")).toBe("backend intern");
  });

  it("collapses internal whitespace runs to a single space", () => {
    expect(normalizeForDedup("Backend    Engineering   Intern")).toBe("backend engineering intern");
  });

  it("strips common company legal suffixes (including when it means a bare name remains — that's intentional, so 'Acme Corp' and 'Acme Inc' both normalize to the same key)", () => {
    expect(normalizeForDedup("Acme Corp, Inc.")).toBe("acme");
    expect(normalizeForDedup("Nimbus Labs Pvt Ltd")).toBe("nimbus labs");
  });

  it("strips common punctuation, including when a suffix word is also stripped", () => {
    expect(normalizeForDedup("O'Brien & Co.")).toBe("obrien &");
  });

  it("treats null as an empty string rather than throwing", () => {
    expect(normalizeForDedup(null)).toBe("");
  });

  it("does not conflate two different real strings just because both are short", () => {
    expect(normalizeForDedup("Acme")).not.toBe(normalizeForDedup("Zeta"));
  });
});
