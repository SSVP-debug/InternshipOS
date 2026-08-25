// runMatchingForCandidate.ts
//
// Orchestrates Phase 2A matching for a single candidate: loads that
// candidate's owned rows (skill, education, experience, project,
// work_authorization), loads active opportunity_source rows, maps both
// sides through the pure mappers, calls the existing, UNMODIFIED
// matchCandidate() from matchEngine.ts for every pair, and upserts the
// result into opportunity_match keyed on the existing
// UNIQUE(candidate_id, opportunity_source_id) constraint.
//
// This module adds no scoring/eligibility logic of its own — it is
// wiring only. It does not rank, sort for presentation, build a feed,
// or schedule anything; it evaluates every active opportunity once per
// call and reports what happened.
//
// CALLER IS SERVICE-ROLE: this is written for an operator-triggered,
// cross-candidate operation (api/scripts/run-matching.ts), so every
// query below explicitly filters by candidate_id / status rather than
// relying on RLS (a service-role client bypasses RLS entirely). This
// mirrors how writeOpportunitySource.ts already writes to
// opportunity_source under service-role, not the per-request
// req.supabase pattern the candidate-facing routes use.

import type { SupabaseClient } from "@supabase/supabase-js";
import { matchCandidate } from "../matchEngine.js";
import {
  buildCandidateMatchInput,
  type RawEducationRow,
  type RawExperienceRow,
  type RawProjectRow,
  type RawSkillRow,
  type RawWorkAuthorizationRow,
} from "./buildCandidateMatchInput.js";
import { buildOpportunityMatchInput, type RawOpportunitySourceRow } from "./buildOpportunityMatchInput.js";

const SKILL_COLUMNS = "name";
const EDUCATION_COLUMNS = "degree_type, major, enrollment_status, expected_graduation_date, is_primary";
const EXPERIENCE_COLUMNS = "employment_type, is_current";
const PROJECT_COLUMNS = "tech_stack";
const WORK_AUTH_COLUMNS = "status, requires_sponsorship, citizenship_country";

const OPPORTUNITY_SOURCE_COLUMNS =
  "id, employment_type, skills, sponsorship_offered, citizenship_requirement, deadline_date, " +
  "jurisdiction_country, eligible_candidate_countries, citizenship_required_countries, " +
  "requires_existing_work_authorization, required_degree_types, required_majors, " +
  "required_major_match_mode, graduation_not_before, graduation_not_after, required_enrollment_statuses";

export interface EligibilityCounts {
  eligible: number;
  ineligible: number;
  unknown: number;
}

export interface RunMatchingSummary {
  candidateId: string;
  opportunitiesEvaluated: number;
  insertedOrUpdated: number;
  eligibilityCounts: EligibilityCounts;
  errors: string[];
}

/** Error thrown when a prerequisite read (candidate data or the opportunity catalog) fails. Never swallowed. */
export class RunMatchingReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunMatchingReadError";
  }
}

async function loadCandidateMatchInput(supabase: Pick<SupabaseClient, "from">, candidateId: string) {
  const [skillResult, educationResult, experienceResult, projectResult, workAuthResult] = await Promise.all([
    supabase.from("skill").select(SKILL_COLUMNS).eq("candidate_id", candidateId),
    supabase.from("education").select(EDUCATION_COLUMNS).eq("candidate_id", candidateId),
    supabase.from("experience").select(EXPERIENCE_COLUMNS).eq("candidate_id", candidateId),
    supabase.from("project").select(PROJECT_COLUMNS).eq("candidate_id", candidateId),
    supabase.from("work_authorization").select(WORK_AUTH_COLUMNS).eq("candidate_id", candidateId).maybeSingle(),
  ]);

  for (const [label, result] of [
    ["skill", skillResult],
    ["education", educationResult],
    ["experience", experienceResult],
    ["project", projectResult],
  ] as const) {
    if (result.error) {
      throw new RunMatchingReadError(`Failed to load ${label} for candidate ${candidateId}: ${result.error.message}`);
    }
  }

  if (workAuthResult.error) {
    throw new RunMatchingReadError(
      `Failed to load work_authorization for candidate ${candidateId}: ${workAuthResult.error.message}`
    );
  }

  return buildCandidateMatchInput({
    skills: (skillResult.data ?? []) as unknown as RawSkillRow[],
    education: (educationResult.data ?? []) as unknown as RawEducationRow[],
    experience: (experienceResult.data ?? []) as unknown as RawExperienceRow[],
    projects: (projectResult.data ?? []) as unknown as RawProjectRow[],
    // .maybeSingle() returns data: null (no error) when no row exists —
    // that's exactly the "missing work_authorization" case, mapped to
    // null by buildCandidateMatchInput, never defaulted.
    workAuthorization: (workAuthResult.data ?? null) as unknown as RawWorkAuthorizationRow | null,
  });
}

async function loadActiveOpportunitySourceRows(
  supabase: Pick<SupabaseClient, "from">
): Promise<Array<RawOpportunitySourceRow & { id: string }>> {
  const { data, error } = await supabase.from("opportunity_source").select(OPPORTUNITY_SOURCE_COLUMNS).eq("status", "active");

  if (error) {
    throw new RunMatchingReadError(`Failed to load active opportunity_source rows: ${error.message}`);
  }

  return (data ?? []) as unknown as Array<RawOpportunitySourceRow & { id: string }>;
}

export async function runMatchingForCandidate(
  supabase: Pick<SupabaseClient, "from">,
  candidateId: string
): Promise<RunMatchingSummary> {
  const errors: string[] = [];
  const eligibilityCounts: EligibilityCounts = { eligible: 0, ineligible: 0, unknown: 0 };

  // Prerequisite reads — a failure here means matching cannot meaningfully
  // proceed at all, so it throws rather than returning a misleadingly
  // "complete" summary with zero opportunities evaluated.
  const candidateInput = await loadCandidateMatchInput(supabase, candidateId);
  const opportunityRows = await loadActiveOpportunitySourceRows(supabase);

  const rowsToUpsert: Array<{
    candidate_id: string;
    opportunity_source_id: string;
    match_score: number;
    eligibility_status: "eligible" | "ineligible" | "unknown";
    match_breakdown: Record<string, unknown>;
  }> = [];

  for (const row of opportunityRows) {
    const opportunityInput = buildOpportunityMatchInput(row);
    const result = matchCandidate(candidateInput, opportunityInput);

    eligibilityCounts[result.eligibility]++;

    rowsToUpsert.push({
      candidate_id: candidateId,
      opportunity_source_id: row.id,
      match_score: result.score,
      eligibility_status: result.eligibility,
      match_breakdown: {
        breakdown: result.breakdown,
        reasons: result.reasons,
        missing: result.missing,
        unknown: result.unknown,
      },
    });
  }

  let insertedOrUpdated = 0;

  if (rowsToUpsert.length > 0) {
    const { error: upsertError } = await supabase
      .from("opportunity_match")
      .upsert(rowsToUpsert, { onConflict: "candidate_id,opportunity_source_id" });

    if (upsertError) {
      errors.push(`Failed to upsert opportunity_match rows for candidate ${candidateId}: ${upsertError.message}`);
    } else {
      insertedOrUpdated = rowsToUpsert.length;
    }
  }

  return {
    candidateId,
    opportunitiesEvaluated: opportunityRows.length,
    insertedOrUpdated,
    eligibilityCounts,
    errors,
  };
}
