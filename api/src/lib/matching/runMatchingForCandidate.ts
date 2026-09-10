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
// or schedule anything; it evaluates one representative per active,
// deduplicated opportunity group per call (see A3.3.1 below) and reports
// what happened.
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
//
// A3.3.1 — DEDUP-AWARE MATCHING:
//
// Traced during the A3.3 design review: this module used to call
// matchCandidate() and upsert an opportunity_match row for EVERY active
// opportunity_source row, unconditionally — including when two (or more)
// rows represent the same real-world posting (e.g. the same internship
// ingested from both Adzuna and RemoteOK, or a repost under a new
// source_ref). That cost is real and compounding: runMatchingForActiveCandidates.ts
// calls this once per candidate PLUS once per that candidate's active
// resume, daily — so one duplicate pair in the catalog multiplies into
// (1 + active resume count) extra matchCandidate() calls and extra
// opportunity_match rows, per candidate, every single run.
//
// selectMatchableRepresentatives() below groups the freshly-loaded ACTIVE
// rows by the SAME conservative, already-shipped, already-tested
// buildDedupKey(title, company, location) that opportunityFeed.ts uses to
// collapse duplicates for display and opportunity-feed.ts (the route)
// uses to prevent a duplicate application at apply time — reusing that
// one function, not inventing a second, differently-tuned notion of
// "duplicate." Only one representative per group is actually matched.
//
// This is DELIBERATELY NOT a persisted grouping (no new column, no
// migration): grouping is recomputed fresh from whatever is currently
// status = 'active' on every run, which is what makes it self-healing
// around A3.2's freshness expiry with zero changes to that logic — if
// today's representative later expires, it simply drops out of
// loadActiveOpportunitySourceRows's own `status = 'active'` filter, and
// the remaining active duplicate (if any) becomes the representative on
// the very next run, with no re-canonicalization step required.
//
// Representative selection uses the lowest opportunity_source_id
// (ascending, string comparison) — a DIFFERENT tie-break than
// collapseDuplicateSources's "keep the highest match_score," and
// deliberately so: at matching time no scores exist yet (computing them
// is the exact cost being avoided), so the tie-break can only use data
// available before matching. The id order has no semantic meaning beyond
// being deterministic and stable for a given pair of rows.
//
// PROVENANCE IS FULLY PRESERVED: no opportunity_source row is deleted,
// merged, or altered by this change. A non-representative row's own
// source_url/application_url/source_ref/etc. remain exactly as ingested
// — this only changes which rows get matched, never what's stored about
// them. Reversible without any migration: removing the grouping step and
// re-running matching for all active rows restores the old behavior
// exactly, since nothing was ever deleted.
//
// KNOWN, ACCEPTED TRANSITIONAL LIMITATION: an opportunity_match row that
// already existed for a non-representative row (created before this
// change shipped, or by a resume-scoped pass in the same run that
// happened to group differently — see buildOpportunityMatchInput's own
// per-row shape, unaffected) simply stops being refreshed going forward;
// it is not deleted. Feed/Today's own collapseDuplicateSources may show
// that stale row's score for a while if it's currently higher than the
// freshly-computed representative's, until an operator chooses to clean
// it up (no automatic cleanup is performed here — deleting rows is
// explicitly out of scope, see the A3.3 design review's hard
// constraints on destructive changes). The listing's title/company/
// location shown to the candidate is unaffected either way, since both
// rows describe the same real posting by definition of sharing a dedup
// key.

import type { SupabaseClient } from "@supabase/supabase-js";
import { matchCandidate } from "../matchEngine.js";
import { buildDedupKey } from "../opportunityFeed.js";
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

// A3.3.1: title, company, location are new here — matchEngine.ts itself
// never needed them (it only scores skills/eligibility fields), but
// selectMatchableRepresentatives() below needs them to compute the same
// dedup key opportunityFeed.ts already uses. They are read-only inputs
// to that grouping step; buildOpportunityMatchInput() still only reads
// the eligibility/skill columns it always has, ignoring these three.
const OPPORTUNITY_SOURCE_COLUMNS =
  "id, title, company, location, employment_type, skills, sponsorship_offered, citizenship_requirement, deadline_date, " +
  "jurisdiction_country, eligible_candidate_countries, citizenship_required_countries, " +
  "requires_existing_work_authorization, required_degree_types, required_majors, " +
  "required_major_match_mode, graduation_not_before, graduation_not_after, required_enrollment_statuses";

/** The subset of an opportunity_source row selectMatchableRepresentatives() needs — a structural subtype of the full loaded row. */
interface DedupGroupable {
  id: string;
  title: string;
  company: string;
  location: string | null;
}

/**
 * A3.3.1 — groups active opportunity_source rows by buildDedupKey(title,
 * company, location) and keeps exactly one representative per group (the
 * one with the lowest `id`, a stable-but-arbitrary tie-break — see this
 * file's own top-of-file comment for why score-based selection isn't
 * available yet at this point in the pipeline). A row with no duplicates
 * is its own, unaffected representative.
 */
function selectMatchableRepresentatives<T extends DedupGroupable>(rows: T[]): T[] {
  const bestByKey = new Map<string, T>();

  for (const row of rows) {
    const key = buildDedupKey(row);
    const existing = bestByKey.get(key);
    if (!existing || row.id < existing.id) {
      bestByKey.set(key, row);
    }
  }

  return Array.from(bestByKey.values());
}

export interface EligibilityCounts {
  eligible: number;
  ineligible: number;
  unknown: number;
}

export interface RunMatchingSummary {
  candidateId: string;
  /** Gate R2: null for the candidate-level pass, a resume id for a resume-scoped pass. Always present (not optional) so callers can't forget to check it. */
  resumeId: string | null;
  /**
   * A3.3.1: the number of opportunity_source rows actually passed to
   * matchCandidate() — i.e. after duplicate-group representative
   * selection, not the raw count of active rows loaded. Before A3.3.1
   * these were always equal (every active row was matched); a duplicate
   * catalog pair now counts once here, reflecting the compute that
   * actually happened. See loadActiveOpportunitySourceRows /
   * selectMatchableRepresentatives above for how the raw count is
   * reduced.
   */
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

/** A3.3.1: title/company/location are select-only additions for dedup grouping — see this module's top-of-file comment. */
type LoadedOpportunitySourceRow = RawOpportunitySourceRow & DedupGroupable;

async function loadActiveOpportunitySourceRows(
  supabase: Pick<SupabaseClient, "from">
): Promise<LoadedOpportunitySourceRow[]> {
  const { data, error } = await supabase.from("opportunity_source").select(OPPORTUNITY_SOURCE_COLUMNS).eq("status", "active");

  if (error) {
    throw new RunMatchingReadError(`Failed to load active opportunity_source rows: ${error.message}`);
  }

  return (data ?? []) as unknown as LoadedOpportunitySourceRow[];
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
  const activeOpportunityRows = await loadActiveOpportunitySourceRows(supabase);
  // A3.3.1: match only one representative per duplicate group — see this
  // module's top-of-file comment for the full rationale.
  const opportunityRows = selectMatchableRepresentatives(activeOpportunityRows);

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
