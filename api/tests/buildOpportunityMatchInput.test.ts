import { describe, it, expect } from "vitest";
import { buildOpportunityMatchInput } from "../src/lib/matching/buildOpportunityMatchInput.js";
import type { RawOpportunitySourceRow } from "../src/lib/matching/buildOpportunityMatchInput.js";

function fullRow(overrides: Partial<RawOpportunitySourceRow> = {}): RawOpportunitySourceRow {
  return {
    employment_type: "internship",
    skills: ["python", "sql"],
    sponsorship_offered: true,
    citizenship_requirement: "US citizens only",
    deadline_date: "2026-12-01",
    jurisdiction_country: "US",
    eligible_candidate_countries: ["US"],
    citizenship_required_countries: ["US"],
    requires_existing_work_authorization: true,
    required_degree_types: ["bachelor"],
    required_majors: ["Computer Science"],
    required_major_match_mode: "related_field",
    graduation_not_before: "2026-01-01",
    graduation_not_after: "2027-12-31",
    required_enrollment_statuses: ["current"],
    ...overrides,
  };
}

describe("buildOpportunityMatchInput", () => {
  it("maps a full 0022/0023 row correctly", () => {
    const row = fullRow();
    const result = buildOpportunityMatchInput(row);

    expect(result).toEqual({
      employmentType: "internship",
      skills: ["python", "sql"],
      sponsorshipOffered: true,
      citizenshipRequirement: "US citizens only",
      deadlineDate: "2026-12-01",
      jurisdictionCountry: "US",
      eligibleCandidateCountries: ["US"],
      citizenshipRequiredCountries: ["US"],
      requiresExistingWorkAuthorization: true,
      requiredDegreeTypes: ["bachelor"],
      requiredMajors: ["Computer Science"],
      requiredMajorMatchMode: "related_field",
      graduationNotBefore: "2026-01-01",
      graduationNotAfter: "2027-12-31",
      requiredEnrollmentStatuses: ["current"],
    });
  });

  it("maps employment_type and skills correctly on their own", () => {
    const row = fullRow({ employment_type: "co_op", skills: ["figma"] });
    const result = buildOpportunityMatchInput(row);

    expect(result.employmentType).toBe("co_op");
    expect(result.skills).toEqual(["figma"]);
  });

  it("keeps every 0023 eligibility field as null when NULL in the row — the real current ingestion shape", () => {
    const row = fullRow({
      sponsorship_offered: null,
      citizenship_requirement: null,
      jurisdiction_country: null,
      eligible_candidate_countries: null,
      citizenship_required_countries: null,
      requires_existing_work_authorization: null,
      required_degree_types: null,
      required_majors: null,
      required_major_match_mode: null,
      graduation_not_before: null,
      graduation_not_after: null,
      required_enrollment_statuses: null,
    });

    const result = buildOpportunityMatchInput(row);

    expect(result.sponsorshipOffered).toBeNull();
    expect(result.citizenshipRequirement).toBeNull();
    expect(result.jurisdictionCountry).toBeNull();
    expect(result.eligibleCandidateCountries).toBeNull();
    expect(result.citizenshipRequiredCountries).toBeNull();
    expect(result.requiresExistingWorkAuthorization).toBeNull();
    expect(result.requiredDegreeTypes).toBeNull();
    expect(result.requiredMajors).toBeNull();
    expect(result.requiredMajorMatchMode).toBeNull();
    expect(result.graduationNotBefore).toBeNull();
    expect(result.graduationNotAfter).toBeNull();
    expect(result.requiredEnrollmentStatuses).toBeNull();

    // Never silently coerced to an "empty but present" value.
    expect(result.eligibleCandidateCountries).not.toEqual([]);
    expect(result.requiresExistingWorkAuthorization).not.toBe(false);
  });

  it("never infers eligibility from title/company/location — those fields have no representation in the input type at all", () => {
    // RawOpportunitySourceRow intentionally has no title/company/location
    // field to read from — this test documents that guarantee structurally:
    // a row with only the mapped columns produces the exact same result
    // regardless of what a real row's title/company/location might say.
    const row = fullRow({ citizenship_requirement: null, sponsorship_offered: null });
    const result = buildOpportunityMatchInput(row);

    expect(result.citizenshipRequirement).toBeNull();
    expect(result.sponsorshipOffered).toBeNull();
  });
});
