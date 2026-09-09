// eligibilityDataFlow.test.ts
//
// A3.3 end-to-end path test. Proves the full chain actually works, not
// just each link in isolation:
//
//   source adapter → CanonicalListing → opportunity_source row shape
//   → RawOpportunitySourceRow → buildOpportunityMatchInput
//   → OpportunityMatchInput → matchCandidate
//
// by taking a raw, source-shaped response (the same shape
// adzunaAdapter.test.ts / remoteokAdapter.test.ts use), running it
// through the real adapter parser, then feeding the resulting listing's
// eligibility fields — via the exact same field names
// writeOpportunitySource.ts writes into the DB — into the real mapper
// and the real matching engine, and asserting the engine's eligibility
// verdict actually changes as a result.
//
// This does NOT hit a database: opportunity_source column names are
// identical to CanonicalListing's eligibility field names by design
// (see types.ts's module header), so "the row a real upsert would
// produce" is just those fields read straight off the listing — the
// same values writeOpportunitySource.ts would have written.

import { describe, it, expect } from "vitest";
import { parseAdzunaListings } from "../src/lib/ingestion/adapters/adzunaAdapter.js";
import { parseRemoteOkListings } from "../src/lib/ingestion/adapters/remoteokAdapter.js";
import { buildOpportunityMatchInput, type RawOpportunitySourceRow } from "../src/lib/matching/buildOpportunityMatchInput.js";
import { matchCandidate, type CandidateMatchInput } from "../src/lib/matchEngine.js";
import type { CanonicalListing } from "../src/lib/ingestion/types.js";

/** The subset of a listing's fields that become the opportunity_source row (see writeOpportunitySource.ts). */
function toRawRow(listing: CanonicalListing): RawOpportunitySourceRow {
  return {
    employment_type: listing.employment_type,
    skills: listing.skills,
    sponsorship_offered: listing.sponsorship_offered,
    citizenship_requirement: listing.citizenship_requirement,
    deadline_date: listing.deadline_date,
    jurisdiction_country: listing.jurisdiction_country,
    eligible_candidate_countries: listing.eligible_candidate_countries,
    citizenship_required_countries: listing.citizenship_required_countries,
    requires_existing_work_authorization: listing.requires_existing_work_authorization,
    required_degree_types: listing.required_degree_types,
    required_majors: listing.required_majors,
    required_major_match_mode: listing.required_major_match_mode,
    graduation_not_before: listing.graduation_not_before,
    graduation_not_after: listing.graduation_not_after,
    required_enrollment_statuses: listing.required_enrollment_statuses,
  };
}

const candidateNeedingSponsorship: CandidateMatchInput = {
  skills: [],
  education: [],
  experience: [],
  projects: [],
  workAuthorization: { status: "needs_sponsorship", requiresSponsorship: true, citizenshipCountry: "IN" },
};

describe("A3.3 eligibility data flow — Adzuna", () => {
  it("a sponsorship-offered listing makes a sponsorship-needing candidate eligible on that axis", () => {
    const raw = {
      results: [
        {
          id: "9000001",
          title: "Cloud Infrastructure Intern",
          company: { display_name: "Kavali Systems Pvt Ltd" },
          location: { display_name: "Hyderabad, Telangana" },
          description: "Join our cloud team. Visa sponsorship available for exceptional candidates.",
          redirect_url: "https://www.adzuna.in/land/ad/9000001",
          created: "2026-08-08T06:12:00Z",
        },
      ],
    };
    const { listings } = parseAdzunaListings(raw);
    expect(listings).toHaveLength(1);

    const row = toRawRow(listings[0]);
    expect(row.sponsorship_offered).toBe(true); // extraction actually ran
    expect(row.jurisdiction_country).toBe("IN"); // adapter-config signal actually ran

    const opportunity = buildOpportunityMatchInput(row);
    const result = matchCandidate(candidateNeedingSponsorship, opportunity);

    expect(result.reasons).toContain("Requires sponsorship, and this opportunity offers sponsorship");
  });

  it("a sponsorship-not-offered listing makes a sponsorship-needing candidate ineligible", () => {
    const raw = {
      results: [
        {
          id: "9000002",
          title: "Legal Affairs Intern",
          company: { display_name: "Global Traders" },
          location: { display_name: "Mumbai, Maharashtra" },
          description: "Support our legal team. This role does not offer visa sponsorship.",
          redirect_url: "https://www.adzuna.in/land/ad/9000002",
          created: "2026-08-07T06:12:00Z",
        },
      ],
    };
    const { listings } = parseAdzunaListings(raw);
    expect(listings).toHaveLength(1);

    const row = toRawRow(listings[0]);
    expect(row.sponsorship_offered).toBe(false);

    const opportunity = buildOpportunityMatchInput(row);
    const result = matchCandidate(candidateNeedingSponsorship, opportunity);

    expect(result.eligibility).toBe("ineligible");
    expect(result.missing).toContain("Requires employer sponsorship; this opportunity does not offer sponsorship");
  });

  it("a listing with no sponsorship statement leaves that axis unknown, never guessed", () => {
    const raw = {
      results: [
        {
          id: "9000003",
          title: "Software Development Intern",
          company: { display_name: "Kavali Systems Pvt Ltd" },
          location: { display_name: "Bengaluru, Karnataka" },
          description: "We are looking for a Software Development Intern to join our engineering team.",
          redirect_url: "https://www.adzuna.in/land/ad/9000003",
          created: "2026-08-06T06:12:00Z",
        },
      ],
    };
    const { listings } = parseAdzunaListings(raw);
    const row = toRawRow(listings[0]);
    expect(row.sponsorship_offered).toBeNull();

    const opportunity = buildOpportunityMatchInput(row);
    const result = matchCandidate(candidateNeedingSponsorship, opportunity);

    expect(result.unknown).toContain("Sponsorship requirement not specified by this opportunity");
  });
});

describe("A3.3 eligibility data flow — RemoteOK", () => {
  it("a sponsorship-offered listing makes a sponsorship-needing candidate eligible on that axis", () => {
    const raw = [
      {
        id: "9100001",
        position: "DevOps Intern",
        company: "Nimbus Labs",
        tags: ["devops"],
        description: "<p>Remote DevOps internship. Visa sponsorship available for outstanding interns.</p>",
        location: "Worldwide",
        url: "https://remoteok.com/remote-jobs/9100001-devops-intern-nimbus-labs",
        date: "2026-08-09T09:00:00+00:00",
      },
    ];
    const { listings } = parseRemoteOkListings(raw);
    expect(listings).toHaveLength(1);

    const row = toRawRow(listings[0]);
    expect(row.sponsorship_offered).toBe(true);
    expect(row.jurisdiction_country).toBeNull(); // remote-only has no single jurisdiction

    const opportunity = buildOpportunityMatchInput(row);
    const result = matchCandidate(candidateNeedingSponsorship, opportunity);

    expect(result.reasons).toContain("Requires sponsorship, and this opportunity offers sponsorship");
  });
});
