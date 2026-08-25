// buildOpportunityMatchInput.ts
//
// Pure mapper: one public.opportunity_source row into matchEngine.ts's
// OpportunityMatchInput. No Supabase calls, no I/O of any kind — same
// discipline as buildCandidateMatchInput.ts and matchEngine.ts itself.
//
// NEVER GUESS ELIGIBILITY: this is a field-renaming mapper only. Every
// 0023_country_neutral_eligibility.sql column is nullable and means "not
// stated" when NULL (see that migration's own column comments and
// matchEngine.ts's module header) — this mapper passes `null` straight
// through as `null`, never coercing it to `[]`, `false`, or any other
// "empty but present" value that computeEligibility() would treat
// differently. It also never inspects title/company/location/description
// to infer an eligibility field that the row's structured columns don't
// state — that kind of text-parsing inference is explicitly a later,
// separate enrichment phase, not something this mapper does implicitly.
//
// Because every currently-ingested opportunity_source row (Adzuna,
// RemoteOK) has every one of these eligibility columns NULL today (see
// the Phase 2 inspection, finding G), this mapper is expected to produce
// an OpportunityMatchInput with every eligibility field null for every
// real row until a future enrichment phase populates them — and
// matchCandidate() is expected to resolve that to eligibility: "unknown"
// as a result. That is correct, not a bug in this mapper.

import type { CandidateEducationSignal, MajorMatchMode, OpportunityMatchInput } from "../matchEngine.js";

/**
 * Raw shape of one public.opportunity_source row (only the columns this
 * mapper reads — see 0022_opportunity_intelligence_foundation.sql and
 * 0023_country_neutral_eligibility.sql for the full table definition).
 */
export interface RawOpportunitySourceRow {
  employment_type: OpportunityMatchInput["employmentType"];
  skills: string[];
  sponsorship_offered: boolean | null;
  citizenship_requirement: string | null;
  deadline_date: string | null;

  jurisdiction_country: string | null;
  eligible_candidate_countries: string[] | null;
  citizenship_required_countries: string[] | null;
  requires_existing_work_authorization: boolean | null;
  required_degree_types: CandidateEducationSignal["degreeType"][] | null;
  required_majors: string[] | null;
  required_major_match_mode: MajorMatchMode | null;
  graduation_not_before: string | null;
  graduation_not_after: string | null;
  required_enrollment_statuses: CandidateEducationSignal["enrollmentStatus"][] | null;
}

/**
 * Maps one opportunity_source row into matchEngine.ts's
 * OpportunityMatchInput. Pure 1:1 field renaming, per the Phase 2
 * inspection's finding E ("this mapping is total and requires no new
 * column"). Every nullable input field maps straight to `null` output —
 * never defaulted, never inferred from any other field on the row.
 */
export function buildOpportunityMatchInput(row: RawOpportunitySourceRow): OpportunityMatchInput {
  return {
    employmentType: row.employment_type,
    skills: row.skills,
    sponsorshipOffered: row.sponsorship_offered,
    citizenshipRequirement: row.citizenship_requirement,
    deadlineDate: row.deadline_date,

    jurisdictionCountry: row.jurisdiction_country,
    eligibleCandidateCountries: row.eligible_candidate_countries,
    citizenshipRequiredCountries: row.citizenship_required_countries,
    requiresExistingWorkAuthorization: row.requires_existing_work_authorization,
    requiredDegreeTypes: row.required_degree_types,
    requiredMajors: row.required_majors,
    requiredMajorMatchMode: row.required_major_match_mode,
    graduationNotBefore: row.graduation_not_before,
    graduationNotAfter: row.graduation_not_after,
    requiredEnrollmentStatuses: row.required_enrollment_statuses,
  };
}
