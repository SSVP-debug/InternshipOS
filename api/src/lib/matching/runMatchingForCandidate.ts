// runMatchingForCandidate.ts
//
// Orchestrates Phase 2A matching for a single candidate: loads that
// candidate's owned rows (skill, education, experience, project,
// work_authorization), loads active opportunity_source rows, maps both
// sides through the pure mappers, calls the existing, UNMODIFIED
// matchCandidate() from matchEngine.ts for every pair, and writes the
// result into opportunity_match.
//
// This module adds no scoring/eligibility logic of its own — it is
// wiring only. It does not rank, sort for presentation, build a feed,
// or schedule anything; it evaluates every active opportunity once per
// call and reports what happened.
//
// GATE R2 — RESUME SCOPING (optional 3rd parameter, resumeId):
//   - resumeId omitted/undefined/null (the default): unchanged
//     candidate-level behavior — every one of the candidate's skill rows
//     is used, exactly as before Gate R2. Written with resume_id = null.
//   - resumeId provided: skills are loaded through resume_skill instead
//     of directly from skill (education/experience/project/
//     work_authorization are NOT resume-scoped — resumes only narrow the
//     skill set, per the Gate R0 design). Written with that resume_id.
//   matchEngine.ts is not touched either way — it already only ever sees
//   a skill list; this module decides which skill list to hand it.
//
// GATE R2 — WRITE PATH CHANGE: this now calls the
// upsert_opportunity_match_batch() SQL function via .rpc() instead of
// .upsert({ onConflict }). That function exists specifically because
// Postgres cannot infer a partial unique index as an ON CONFLICT target
// from a plain column-list clause, and opportunity_match has had two
// partial unique indexes (not one plain constraint) since
// 0026_opportunity_match_resume.sql — see that migration's own comments
// for the full reasoning. This is a real, deliberate behavior change
// from Gate R1 and earlier, not a refactor for its own sake.
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
  /** Gate R2: null for the candidate-level pass, a resume id for a resume-scoped pass. Always present (not optional) so callers can't forget to check it. */
  resumeId: string | null;
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

/**
 * Gate R2: loads the skill rows for a resume-scoped match — via
 * resume_skill, not directly from skill by candidate_id. Deliberately a
 * separate function (not a branch bolted into the candidate-level skill
 * query) so the "how a resume's skills are found" logic has one obvious
 * place to read, matching the module's existing one-function-per-source
 * shape.
 *
 * Ownership is NOT re-checked here (this runs under service-role, and
 * the caller — runMatchingForCandidate — is only ever given a resumeId
 * that it already loaded for this same candidateId; see
 * runMatchingForActiveCandidates.ts). resume_skill's own RLS/FK
 * ownership guarantees are what stops a skill belonging to a different
 * candidate from ever being linked into this resume in the first place
 * (0025_resume.sql's resume_skill_insert_own policy) — this function
 * just reads what's already there.
 */
async function loadResumeSkillRows(
  supabase: Pick<SupabaseClient, "from">,
  resumeId: string
): Promise<RawSkillRow[]> {
  const { data, error } = await supabase
    .from("resume_skill")
    .select("skill(name)")
    .eq("resume_id", resumeId);

  if (error) {
    throw new RunMatchingReadError(`Failed to load resume_skill rows for resume ${resumeId}: ${error.message}`);
  }

  // Supabase's foreign-table embedding returns `{ skill: { name } }` per
  // row (or `{ skill: null }` only if the FK were nullable, which
  // resume_skill.skill_id is not — kept as a defensive filter, not a
  // silent default, matching this file's own no-guessing convention).
  return ((data ?? []) as unknown as Array<{ skill: RawSkillRow | null }>)
    .map((row) => row.skill)
    .filter((skill): skill is RawSkillRow => skill !== null);
}

async function loadCandidateMatchInput(
  supabase: Pick<SupabaseClient, "from">,
  candidateId: string,
  resumeId?: string | null
) {
  const [skillResult, educationResult, experienceResult, projectResult, workAuthResult] = await Promise.all([
    resumeId
      ? loadResumeSkillRows(supabase, resumeId)
      : supabase
          .from("skill")
          .select(SKILL_COLUMNS)
          .eq("candidate_id", candidateId)
          .then((result) => {
            if (result.error) {
              throw new RunMatchingReadError(`Failed to load skill for candidate ${candidateId}: ${result.error.message}`);
            }
            return (result.data ?? []) as unknown as RawSkillRow[];
          }),
    supabase.from("education").select(EDUCATION_COLUMNS).eq("candidate_id", candidateId),
    supabase.from("experience").select(EXPERIENCE_COLUMNS).eq("candidate_id", candidateId),
    supabase.from("project").select(PROJECT_COLUMNS).eq("candidate_id", candidateId),
    supabase.from("work_authorization").select(WORK_AUTH_COLUMNS).eq("candidate_id", candidateId).maybeSingle(),
  ]);

  for (const [label, result] of [
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
    // skillResult is already RawSkillRow[] in both branches above — the
    // resume branch returns it directly, the candidate-level branch
    // unwraps { data, error } to the same shape via .then() so both
    // sides of the Promise.all array line up.
    skills: skillResult as RawSkillRow[],
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
  supabase: Pick<SupabaseClient, "from" | "rpc">,
  candidateId: string,
  resumeId?: string | null
): Promise<RunMatchingSummary> {
  const normalizedResumeId = resumeId ?? null;
  const errors: string[] = [];
  const eligibilityCounts: EligibilityCounts = { eligible: 0, ineligible: 0, unknown: 0 };

  // Prerequisite reads — a failure here means matching cannot meaningfully
  // proceed at all, so it throws rather than returning a misleadingly
  // "complete" summary with zero opportunities evaluated.
  const candidateInput = await loadCandidateMatchInput(supabase, candidateId, normalizedResumeId);
  const opportunityRows = await loadActiveOpportunitySourceRows(supabase);

  const rowsToUpsert: Array<{
    candidate_id: string;
    opportunity_source_id: string;
    resume_id: string | null;
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
      resume_id: normalizedResumeId,
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
    // Gate R2: opportunity_match now has two partial unique indexes
    // (resume_id IS NULL / IS NOT NULL) instead of one plain constraint
    // — see 0026_opportunity_match_resume.sql. A plain client-side
    // .upsert({ onConflict }) cannot target a partial index (Postgres
    // requires the WHERE predicate to be repeated in the ON CONFLICT
    // clause itself, which the supabase-js query builder has no way to
    // express), so this calls the SQL-side batch-upsert function
    // instead, which performs the correct two-branch
    // INSERT ... ON CONFLICT (...) WHERE ... for this same row set in
    // one round trip.
    const { error: upsertError } = await supabase.rpc("upsert_opportunity_match_batch", {
      p_rows: rowsToUpsert,
    });

    if (upsertError) {
      errors.push(`Failed to upsert opportunity_match rows for candidate ${candidateId}: ${upsertError.message}`);
    } else {
      insertedOrUpdated = rowsToUpsert.length;
    }
  }

  return {
    candidateId,
    resumeId: normalizedResumeId,
    opportunitiesEvaluated: opportunityRows.length,
    insertedOrUpdated,
    eligibilityCounts,
    errors,
  };
}
