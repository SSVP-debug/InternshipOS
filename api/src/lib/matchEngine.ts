// matchEngine.ts
// Pure deterministic matching engine for Opportunity Intelligence.
// Source of truth for field availability: the Phase 1B candidate-data
// audit (Skills/Education/Experience/Projects/WorkAuthorization sections)
// and the Phase 1B.6 "Country-Neutral Eligibility Model" design document.
//
// Same "logic separated from I/O for testability" discipline as
// todayView.ts: this module has NO database client, NO HTTP, NO
// environment variables, and NO network calls of any kind, so it is
// reusable as-is by any future caller — an API route, an ingestion job,
// a daily scheduler, a Discord bot, a WhatsApp bot — without any of them
// pulling in Express or Supabase. All input is passed in; nothing is
// fetched from inside this file.
//
// PRIVACY BOUNDARY (enforced by field selection in the input types below,
// not by a runtime check — there is nothing here to check against,
// because the excluded fields are never part of the input type at all):
//   This module never reads public.personal_info, and the CandidateMatchInput
//   type below has no field for legal name, email, phone, location_city,
//   location_country, or pronouns. A caller cannot "accidentally" leak
//   these into a match — the type simply has no slot for them. See
//   0003_personal_info.sql's own table comment: "PII domain. Never read
//   by matching/generation code paths or sent to an LLM." This module is
//   exactly such a matching code path. citizenshipCountry (added in
//   Phase 1B.6, see below) is NOT personal_info — it lives on
//   public.work_authorization, a separate, non-PII-walled table.
//
// WORK AUTHORIZATION SEMANTICS:
//   CandidateMatchInput.workAuthorization is `WorkAuthorizationSignal | null`.
//   `null` means "no public.work_authorization row exists for this
//   candidate" (mirrors the API's own 404 work_authorization_not_found —
//   see api/src/routes/work-authorization.ts). This is never defaulted to
//   eligible or ineligible; see computeEligibility below.
//
// KNOWN LIMITATION — SINGLE-JURISDICTION WORK AUTHORIZATION (Phase 1B.6):
//   public.work_authorization is a single row per candidate. A candidate
//   who is, for example, an Indian citizen working domestically AND
//   separately eligible for a US-sponsored role genuinely has two
//   different authorization realities, but the schema (and therefore this
//   module) can only represent one. This module does NOT attempt to work
//   around that by inventing a second implicit context — every eligibility
//   signal below is evaluated against the single work_authorization row
//   the candidate has, honestly, and resolves to `unknown` rather than
//   guessing whenever that single row is insufficient to answer a
//   jurisdiction-specific question. Redesigning work_authorization into a
//   multi-jurisdiction model is explicitly out of scope for this phase
//   (see the Phase 1B.6 design document, §8).
//
// OPPORTUNITY sponsorship_offered SEMANTICS:
//   OpportunityMatchInput.sponsorshipOffered is `boolean | null`, mirroring
//   opportunity_source.sponsorship_offered exactly (0022_opportunity_
//   intelligence_foundation.sql: "NULL means unknown... must never be
//   treated as 'no sponsorship'"). `null` is never coerced to `false`
//   anywhere in this file.
//
// COUNTRY-NEUTRAL ELIGIBILITY (Phase 1B.6):
//   The previous version of this module resolved citizenship-based
//   eligibility with a hardcoded, US-only literal-phrase parser
//   (checking free text for "u.s. citizen" / "us citizen" / "united
//   states citizen"). Two offline reality tests — 14 real US/
//   international postings and 13 real India-market postings — showed
//   this was a real architectural problem: the phrase list never matched
//   any of the real Indian postings (because Indian postings don't use
//   that pattern at all), and even on US data it produced a false
//   negative on a real posting whose phrasing didn't happen to include
//   one of the hardcoded qualifier words. That parser has been REMOVED
//   and replaced by structured, country-neutral comparison against
//   opportunity_source's new eligibility columns (jurisdiction_country,
//   eligible_candidate_countries, citizenship_required_countries,
//   requires_existing_work_authorization, required_degree_types,
//   required_majors, required_major_match_mode, graduation_not_before,
//   graduation_not_after, required_enrollment_statuses — added by
//   0023_country_neutral_eligibility.sql). Free-text
//   `citizenshipRequirement` is retained only as a fallback signal: if
//   present but no structured `citizenshipRequiredCountries` was
//   supplied, it produces an `unknown` signal (something was stated but
//   this module cannot safely structure it), never a guessed
//   eligible/ineligible. See computeEligibility below.

import { normalizeSkillList } from "./skillNormalization.js";

// ── Input contract ──────────────────────────────────────────────────────
// Field selection here matches the Phase 1B audit's proposed
// CandidateMatchInput / OpportunityMatchInput, extended per the Phase
// 1B.6 design document's approved CandidateEligibilityContext /
// OpportunityEligibilityRequirements. Do not widen these types to include
// personal_info fields — see the privacy boundary note above.

export interface CandidateSkillSignal {
  /** public.skill.name, raw (pre-normalization happens inside this module). */
  name: string;
}

export interface CandidateEducationSignal {
  /** public.education.degree_type */
  degreeType: "associate" | "bachelor" | "master" | "phd" | "bootcamp" | "other";
  /** public.education.major */
  major: string;
  /** public.education.enrollment_status */
  enrollmentStatus: "current" | "graduated" | "on_leave" | "transferred" | "withdrawn";
  /** public.education.expected_graduation_date (YYYY-MM-DD), nullable */
  expectedGraduationDate: string | null;
  /** public.education.is_primary */
  isPrimary: boolean;
}

export interface CandidateExperienceSignal {
  /** public.experience.employment_type */
  employmentType: "internship" | "part_time" | "full_time" | "research" | "volunteer";
  /** public.experience.is_current */
  isCurrent: boolean;
  // description_raw is deliberately NOT included here — it is unstructured
  // free text (audit §A.3) and this v1 engine does not attempt keyword
  // inference from it, per the task brief's explicit caution against
  // "pretending description_raw is structured skill data."
}

export interface CandidateProjectSignal {
  /** public.project.tech_stack, raw (pre-normalization happens inside this module). */
  techStack: string[];
}

export interface WorkAuthorizationSignal {
  /**
   * public.work_authorization.status. Retained as candidate eligibility
   * CONTEXT (per the Phase 1B.6 design doc's CandidateEligibilityContext)
   * but — deliberately — no eligibility rule in this module compares
   * against this field directly. It is US-immigration-shaped
   * (us_citizen/f1_opt/h1b/etc — unchanged in this phase, per the task
   * brief's explicit instruction not to add enum values), and using it in
   * a country-neutral comparison would silently re-introduce the exact
   * US-centric assumption Phase 1B.6 was commissioned to remove. Country-
   * neutral comparisons use citizenshipCountry and requiresSponsorship
   * instead, both of which are already country-neutral by construction.
   */
  status:
    | "us_citizen"
    | "permanent_resident"
    | "f1_opt"
    | "f1_cpt"
    | "stem_opt_eligible"
    | "h1b"
    | "other_visa"
    | "needs_sponsorship"
    | "not_applicable_non_us";
  /** public.work_authorization.requires_sponsorship — never null once the row exists (DB NOT NULL). */
  requiresSponsorship: boolean;
  /**
   * public.work_authorization.citizenship_country (Phase 1B.6). Already
   * existed in the database prior to this phase but was not previously
   * consumed by this module — this is the field that makes eligibility
   * comparisons country-neutral rather than US-only. Free-form country
   * identifier (e.g. "IN", "US"), not an enum — matches the DB column's
   * own free-text type. NOT personal_info: this lives on
   * work_authorization, a separate, non-PII-walled table.
   */
  citizenshipCountry: string;
}

export interface CandidateMatchInput {
  skills: CandidateSkillSignal[];
  education: CandidateEducationSignal[];
  experience: CandidateExperienceSignal[];
  projects: CandidateProjectSignal[];
  /**
   * null = no public.work_authorization row exists yet for this candidate
   * (mirrors GET /work-authorization's 404). Never defaulted.
   */
  workAuthorization: WorkAuthorizationSignal | null;
}

/** opportunity_source.required_major_match_mode (Phase 1B.6). */
export type MajorMatchMode = "exact" | "related_field";

export interface OpportunityMatchInput {
  /** opportunity_source.employment_type */
  employmentType: "internship" | "co_op" | "full_time" | "part_time";
  /** opportunity_source.skills, raw (pre-normalization happens inside this module). */
  skills: string[];
  /**
   * opportunity_source.sponsorship_offered — tri-state. null = unknown,
   * never coerced to false. See module header.
   */
  sponsorshipOffered: boolean | null;
  /**
   * opportunity_source.citizenship_requirement — free text, nullable.
   * Fallback-only (Phase 1B.6): if non-empty and citizenshipRequiredCountries
   * is not supplied, this produces an `unknown` eligibility signal rather
   * than being parsed. See module header and computeEligibility.
   */
  citizenshipRequirement: string | null;
  /** opportunity_source.deadline_date (YYYY-MM-DD), nullable. */
  deadlineDate: string | null;

  // ── Phase 1B.6 country-neutral eligibility fields ──────────────────────
  // All nullable/additive, mirroring 0023_country_neutral_eligibility.sql
  // exactly. null on any of these means "not stated by this opportunity"
  // and produces NO eligibility signal for that axis — see
  // computeEligibility's per-axis evaluators below, each of which
  // documents its own three-way null/unknown/resolved behavior.

  /** opportunity_source.jurisdiction_country. Context only — see evaluateExistingWorkAuthorizationSignal for the one narrow, bounded use of this field. Never used to invent general immigration rules. */
  jurisdictionCountry: string | null;
  /** opportunity_source.eligible_candidate_countries. Explicit allow-list; null/empty = unrestricted or unstated. */
  eligibleCandidateCountries: string[] | null;
  /** opportunity_source.citizenship_required_countries. Structured citizenship requirement — replaces the old US-only phrase parser. */
  citizenshipRequiredCountries: string[] | null;
  /** opportunity_source.requires_existing_work_authorization. Tri-state, same discipline as sponsorshipOffered. */
  requiresExistingWorkAuthorization: boolean | null;
  /** opportunity_source.required_degree_types, using the same vocabulary as CandidateEducationSignal.degreeType. */
  requiredDegreeTypes: CandidateEducationSignal["degreeType"][] | null;
  /** opportunity_source.required_majors, free text. */
  requiredMajors: string[] | null;
  /** opportunity_source.required_major_match_mode. null only when requiredMajors is null. */
  requiredMajorMatchMode: MajorMatchMode | null;
  /** opportunity_source.graduation_not_before (YYYY-MM-DD), nullable. */
  graduationNotBefore: string | null;
  /** opportunity_source.graduation_not_after (YYYY-MM-DD), nullable. */
  graduationNotAfter: string | null;
  /** opportunity_source.required_enrollment_statuses, using the same vocabulary as CandidateEducationSignal.enrollmentStatus. */
  requiredEnrollmentStatuses: CandidateEducationSignal["enrollmentStatus"][] | null;
}

// ── Output contract ─────────────────────────────────────────────────────
// Unchanged from Phase 1B — the eligibility architecture underneath
// changed, but the shape callers already depend on did not.

export type EligibilityStatus = "eligible" | "ineligible" | "unknown";

export interface MatchBreakdown {
  skills: number;
  education: number;
  experience: number;
  projects: number;
}

export interface MatchResult {
  score: number;
  eligibility: EligibilityStatus;
  breakdown: MatchBreakdown;
  reasons: string[];
  missing: string[];
  unknown: string[];
}

// ── Scoring weights ──────────────────────────────────────────────────────
// UNCHANGED in this phase — Phase 1B.6 is an eligibility-architecture
// change only, per the task brief's explicit instruction not to redesign
// or tune skill/project/education/experience scoring. Rationale retained
// from Phase 1B for reference:
//
//   skills     (45 pts) — the ONLY domain with a directly comparable
//                          structured field on both sides
//                          (candidate skill.name vs opportunity_source.skills).
//   education  (25 pts) — an intrinsic readiness signal (see
//                          computeEducation below), not a true
//                          candidate-vs-opportunity match — that gap is
//                          now partially closed by the new eligibility
//                          axes (degree/major/graduation/enrollment
//                          requirements), which are evaluated separately
//                          as ELIGIBILITY signals, not folded into this
//                          score component. The two are deliberately kept
//                          apart: this score component asks "is this
//                          candidate generally internship-ready," while
//                          the new eligibility axes ask "does this
//                          specific candidate satisfy this specific
//                          opportunity's stated requirements."
//   experience (15 pts) — only employment_type and current/duration are
//                          structured; description_raw is NOT used.
//   projects   (15 pts) — credits skills found in tech_stack that are NOT
//                          already present in the candidate's declared
//                          skill list, to avoid double-counting.
//
// Total: 45 + 25 + 15 + 15 = 100.
export const SKILLS_WEIGHT = 45;
export const EDUCATION_WEIGHT = 25;
export const EXPERIENCE_WEIGHT = 15;
export const PROJECTS_WEIGHT = 15;

// ── Skills + Projects (combined to avoid double-counting) ───────────────
// UNCHANGED in this phase.

interface SkillsAndProjectsResult {
  skillsScore: number;
  projectsScore: number;
  reasons: string[];
  missing: string[];
}

function computeSkillsAndProjects(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): SkillsAndProjectsResult {
  const opportunitySkills = normalizeSkillList(opportunity.skills);
  const candidateSkillNames = normalizeSkillList(candidate.skills.map((s) => s.name));
  const projectTechStack = normalizeSkillList(
    candidate.projects.flatMap((p) => p.techStack)
  );

  const candidateSkillSet = new Set(candidateSkillNames);
  const projectTechSet = new Set(projectTechStack);

  const reasons: string[] = [];
  const missing: string[] = [];

  // No opportunity skills to compare against at all — nothing to score,
  // nothing to report as missing. Documented limitation (audit §D): this
  // is a gap in the opportunity's own data, not a candidate shortfall, so
  // it is scored 0 rather than defaulted to full credit either way.
  if (opportunitySkills.length === 0) {
    return { skillsScore: 0, projectsScore: 0, reasons, missing };
  }

  const matchedViaSkills: string[] = [];
  const matchedViaProjectsOnly: string[] = [];
  const unmatched: string[] = [];

  for (const oppSkill of opportunitySkills) {
    if (candidateSkillSet.has(oppSkill)) {
      // Matched via the candidate's declared skill list — credited here
      // and here only, even if the same normalized skill also appears in
      // a project's tech_stack (avoids double-counting per the task brief).
      matchedViaSkills.push(oppSkill);
    } else if (projectTechSet.has(oppSkill)) {
      // Not in the declared skill list, but demonstrated in a project —
      // distinct evidence, credited under the projects component only.
      matchedViaProjectsOnly.push(oppSkill);
    } else {
      unmatched.push(oppSkill);
    }
  }

  for (const skill of matchedViaSkills) reasons.push(`Matches ${skill}`);
  for (const skill of matchedViaProjectsOnly) reasons.push(`Matches ${skill} (via project experience)`);
  for (const skill of unmatched) missing.push(skill);

  const skillsScore = Math.round((SKILLS_WEIGHT * matchedViaSkills.length) / opportunitySkills.length);
  const projectsScore = Math.round(
    (PROJECTS_WEIGHT * matchedViaProjectsOnly.length) / opportunitySkills.length
  );

  return { skillsScore, projectsScore, reasons, missing };
}

// ── Education (score component) ───────────────────────────────────────────
// UNCHANGED in this phase. See the weights comment above: this is an
// intrinsic readiness signal, distinct from the new degree/major/
// graduation/enrollment ELIGIBILITY axes below, which compare against
// opportunity-stated requirements instead.

interface EducationResult {
  score: number;
  reasons: string[];
  missing: string[];
  unknown: string[];
}

/**
 * Picks the education record most relevant to matching: the row marked
 * is_primary, or if none is marked primary, the one with the latest
 * expected_graduation_date (a reasonable deterministic tiebreak — the
 * "most current/forward-looking" program), or if none of those exist,
 * the first row. Returns null if the candidate has no education records.
 *
 * Shared by both the education SCORE component and the degree/major/
 * graduation/enrollment ELIGIBILITY signals (Phase 1B.6) — one consistent
 * notion of "the candidate's primary education record" throughout.
 */
function pickPrimaryEducation(
  education: CandidateEducationSignal[]
): CandidateEducationSignal | null {
  if (education.length === 0) return null;
  const primary = education.find((e) => e.isPrimary);
  if (primary) return primary;
  const withGradDate = education.filter((e) => e.expectedGraduationDate !== null);
  if (withGradDate.length > 0) {
    return withGradDate.reduce((latest, e) =>
      (e.expectedGraduationDate as string) > (latest.expectedGraduationDate as string) ? e : latest
    );
  }
  return education[0];
}

const ENROLLMENT_WEIGHT = 15;
const GRADUATION_TIMING_WEIGHT = 10; // ENROLLMENT_WEIGHT + GRADUATION_TIMING_WEIGHT === EDUCATION_WEIGHT

function computeEducation(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): EducationResult {
  const reasons: string[] = [];
  const missing: string[] = [];
  const unknown: string[] = [];

  const primary = pickPrimaryEducation(candidate.education);
  if (!primary) {
    unknown.push("No education record found");
    return { score: 0, reasons, missing, unknown };
  }

  let score = 0;

  // Enrollment status sub-component (15 pts).
  switch (primary.enrollmentStatus) {
    case "current":
      score += ENROLLMENT_WEIGHT;
      reasons.push(`Current ${primary.degreeType} student in ${primary.major}`);
      break;
    case "on_leave":
    case "transferred":
      score += Math.round(ENROLLMENT_WEIGHT / 2);
      reasons.push(`Currently enrolled (${primary.enrollmentStatus}) in ${primary.degreeType} program`);
      break;
    case "graduated":
      score += Math.round(ENROLLMENT_WEIGHT / 3);
      reasons.push(`Graduated with ${primary.degreeType} in ${primary.major}`);
      break;
    case "withdrawn":
      missing.push("Not currently enrolled (withdrawn)");
      break;
  }

  // Graduation timing sub-component (10 pts) — only evaluable if both the
  // candidate's expected graduation date and the opportunity's deadline
  // are known; otherwise this is explicitly unknown, not defaulted.
  if (primary.expectedGraduationDate === null) {
    unknown.push("Expected graduation date not provided");
  } else if (opportunity.deadlineDate === null) {
    unknown.push("Opportunity deadline not specified — cannot evaluate graduation timing");
  } else if (primary.expectedGraduationDate >= opportunity.deadlineDate) {
    score += GRADUATION_TIMING_WEIGHT;
    reasons.push("On track to still be enrolled at the opportunity's application deadline");
  } else {
    missing.push("Expected graduation date is before the opportunity's application deadline");
  }

  return { score, reasons, missing, unknown };
}

// ── Experience (score component) ────────────────────────────────────────
// UNCHANGED in this phase.

interface ExperienceResult {
  score: number;
  reasons: string[];
  missing: string[];
}

const INTERNSHIP_EXPERIENCE_WEIGHT = 10;
const MATCHING_TYPE_EXPERIENCE_WEIGHT = 5; // INTERNSHIP_EXPERIENCE_WEIGHT + MATCHING_TYPE_EXPERIENCE_WEIGHT === EXPERIENCE_WEIGHT

function computeExperience(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): ExperienceResult {
  const reasons: string[] = [];
  const missing: string[] = [];

  if (candidate.experience.length === 0) {
    missing.push("No prior experience listed");
    return { score: 0, reasons, missing };
  }

  const hasInternshipExperience = candidate.experience.some((e) => e.employmentType === "internship");
  const hasMatchingTypeExperience = candidate.experience.some(
    (e) => e.employmentType === opportunity.employmentType
  );

  let score = 0;

  if (hasInternshipExperience) {
    score += INTERNSHIP_EXPERIENCE_WEIGHT;
    reasons.push("Has relevant internship experience");
  }

  // Only credited separately when the opportunity isn't itself an
  // internship (otherwise this would just re-describe the same fact
  // already credited above, not a distinct signal).
  if (hasMatchingTypeExperience && opportunity.employmentType !== "internship") {
    score += MATCHING_TYPE_EXPERIENCE_WEIGHT;
    reasons.push(`Has prior ${opportunity.employmentType.replace("_", "-")} experience`);
  }

  if (!hasInternshipExperience && !hasMatchingTypeExperience) {
    missing.push("No experience matching this opportunity's employment type");
  }

  return { score, reasons, missing };
}

// ── Eligibility (Phase 1B.6 — country-neutral) ───────────────────────────
//
// Each eligibility axis below is evaluated INDEPENDENTLY as its own
// signal, following the semantics locked in the Phase 1B.6 design
// document:
//
//   1. Opportunity states nothing about a requirement axis
//        → the evaluator returns `null` — NO signal is produced for that
//          axis. It does not participate in the combination at all.
//   2. Opportunity explicitly states a requirement, but the candidate's
//      corresponding data is missing
//        → the evaluator returns an `unknown` signal.
//   3. Opportunity explicitly states a requirement in free text that
//      cannot be safely structured (citizenshipRequirement fallback only)
//        → `unknown` signal.
//   4. Opportunity states a requirement AND candidate data resolves it
//        → `eligible` or `ineligible` signal, per the specific comparison.
//
// All PRODUCED signals (i.e. not null) are combined by the same
// most-conservative-wins rule as before: any `ineligible` signal wins
// outright; else any `unknown` signal wins; else `eligible`. If literally
// zero signals were produced (which in practice requires
// workAuthorization to be non-null AND every opportunity eligibility
// field to be null — see evaluateSponsorshipSignal, which is the one axis
// still evaluated unconditionally whenever workAuthorization exists, per
// the task brief's explicit instruction to preserve its existing
// behavior), the result is `unknown` rather than a default `eligible`.

interface EligibilitySignal {
  status: EligibilityStatus;
  text: string;
}

/**
 * Sponsorship signal. UNCHANGED behavior from Phase 1B, per the task
 * brief's explicit instruction: "Preserve existing tri-state behavior.
 * Never coerce null to false." This is the one axis still evaluated
 * unconditionally (never returns null) whenever any work_authorization
 * data exists — a candidate who doesn't require sponsorship is `eligible`
 * on this axis regardless of what the opportunity did or didn't state
 * about sponsorship, exactly as before Phase 1B.6.
 */
function evaluateSponsorshipSignal(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): EligibilitySignal {
  if (!candidate.workAuthorization) {
    return {
      status: "unknown",
      text: "Work authorization not provided; cannot determine whether sponsorship is required",
    };
  }
  const wa = candidate.workAuthorization;
  if (!wa.requiresSponsorship) {
    return { status: "eligible", text: "Does not require employer sponsorship" };
  }
  if (opportunity.sponsorshipOffered === true) {
    return { status: "eligible", text: "Requires sponsorship, and this opportunity offers sponsorship" };
  }
  if (opportunity.sponsorshipOffered === false) {
    return {
      status: "ineligible",
      text: "Requires employer sponsorship; this opportunity does not offer sponsorship",
    };
  }
  // sponsorship_offered === null: unknown, never coerced to false.
  return { status: "unknown", text: "Sponsorship requirement not specified by this opportunity" };
}

/**
 * Eligible-candidate-countries signal (Phase 1B.6). Structured allow-list
 * comparison — country-neutral by construction, works identically for
 * any country's restriction, not just US ones.
 */
function evaluateEligibleCountriesSignal(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): EligibilitySignal | null {
  const allowList = opportunity.eligibleCandidateCountries;
  if (!allowList || allowList.length === 0) return null; // not stated — no signal

  const citizenship = candidate.workAuthorization?.citizenshipCountry ?? null;
  if (!citizenship) {
    return {
      status: "unknown",
      text: "Candidate citizenship country not provided; cannot verify the opportunity's eligible-countries requirement",
    };
  }
  if (allowList.includes(citizenship)) {
    return {
      status: "eligible",
      text: `Citizenship (${citizenship}) is among the opportunity's eligible candidate countries`,
    };
  }
  return {
    status: "ineligible",
    text: `Opportunity restricts eligibility to specific candidate countries; candidate citizenship (${citizenship}) is not among them`,
  };
}

/**
 * Structured citizenship-requirement signal (Phase 1B.6). REPLACES the
 * previous US-only literal-phrase parser entirely. Falls back to an
 * `unknown` signal (never a guess) when only free text is available.
 */
function evaluateCitizenshipRequirementSignal(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): EligibilitySignal | null {
  const required = opportunity.citizenshipRequiredCountries;
  if (required && required.length > 0) {
    const citizenship = candidate.workAuthorization?.citizenshipCountry ?? null;
    if (!citizenship) {
      return {
        status: "unknown",
        text: "Candidate citizenship country not provided; cannot verify the opportunity's citizenship requirement",
      };
    }
    if (required.includes(citizenship)) {
      return { status: "eligible", text: `Meets the opportunity's citizenship requirement (${citizenship})` };
    }
    return {
      status: "ineligible",
      text: `Opportunity requires citizenship of one of [${required.join(", ")}]; candidate citizenship (${citizenship}) does not match`,
    };
  }

  // No structured requirement — fall back to the free-text field ONLY to
  // detect that *something* was stated. Deliberately does NOT parse it:
  // per the Phase 1B.6 design doc, unstructured citizenship-adjacent text
  // always resolves to `unknown`, never a guessed eligible/ineligible.
  if (opportunity.citizenshipRequirement && opportunity.citizenshipRequirement.trim() !== "") {
    return {
      status: "unknown",
      text: "Citizenship-related requirement text present but not structured into a verifiable requirement",
    };
  }

  return null; // nothing stated at all — no signal
}

/**
 * Existing-work-authorization signal (Phase 1B.6). The one place this
 * module makes any inference involving jurisdictionCountry, and it is
 * deliberately narrow: a candidate whose citizenshipCountry equals the
 * opportunity's jurisdictionCountry, and who does not require sponsorship,
 * is treated as already authorized to work there. This is a direct,
 * structural comparison of two already-known non-PII strings — NOT a
 * general immigration-law inference (which the task brief explicitly
 * prohibits). Any case this narrow rule doesn't cover resolves to
 * `unknown`, honestly reflecting the single-jurisdiction work_authorization
 * limitation documented at the top of this file.
 */
function evaluateExistingWorkAuthorizationSignal(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): EligibilitySignal | null {
  if (opportunity.requiresExistingWorkAuthorization === null) return null; // not stated
  if (opportunity.requiresExistingWorkAuthorization === false) {
    return { status: "eligible", text: "Opportunity does not require pre-existing work authorization" };
  }

  // requiresExistingWorkAuthorization === true from here on.
  if (!candidate.workAuthorization) {
    return {
      status: "unknown",
      text: "Work authorization not provided; cannot verify the opportunity's pre-existing work-authorization requirement",
    };
  }
  const wa = candidate.workAuthorization;
  if (wa.requiresSponsorship) {
    return {
      status: "ineligible",
      text: "Opportunity requires pre-existing work authorization with no employer action; candidate requires employer sponsorship",
    };
  }
  // requiresSponsorship === false from here on — candidate needs no
  // employer action, but that alone doesn't prove authorization in THIS
  // opportunity's specific jurisdiction (single-jurisdiction limitation).
  // The one narrow, defensible exception: citizenship of the same country
  // as the opportunity's jurisdiction.
  if (
    opportunity.jurisdictionCountry &&
    wa.citizenshipCountry &&
    opportunity.jurisdictionCountry === wa.citizenshipCountry
  ) {
    return {
      status: "eligible",
      text: `Candidate citizenship (${wa.citizenshipCountry}) matches the opportunity's jurisdiction and requires no sponsorship`,
    };
  }
  return {
    status: "unknown",
    text: "Cannot verify pre-existing work authorization for this opportunity's jurisdiction from available data",
  };
}

/**
 * Degree-requirement signal (Phase 1B.6).
 */
function evaluateDegreeSignal(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): EligibilitySignal | null {
  const required = opportunity.requiredDegreeTypes;
  if (!required || required.length === 0) return null; // not stated

  const primary = pickPrimaryEducation(candidate.education);
  if (!primary) {
    return { status: "unknown", text: "Degree requirement stated but candidate has no education record" };
  }
  if (required.includes(primary.degreeType)) {
    return { status: "eligible", text: `Meets the opportunity's degree requirement (${primary.degreeType})` };
  }
  return {
    status: "ineligible",
    text: `Opportunity requires one of [${required.join(", ")}]; candidate's degree (${primary.degreeType}) does not match`,
  };
}

// Deliberately tiny, explicit related-field groupings — NOT a general
// academic taxonomy. Extend only with concrete, justified groupings, same
// discipline as skillNormalization.ts's alias table. Comparisons are
// case-insensitive/trimmed; values here are already normalized (lowercase).
const RELATED_MAJOR_GROUPS: string[][] = [
  ["computer science", "computer engineering", "information technology", "software engineering"],
];

function normalizeMajor(major: string): string {
  return major.trim().toLowerCase();
}

function isRelatedMajor(candidateMajor: string, requiredMajors: string[]): boolean {
  return RELATED_MAJOR_GROUPS.some(
    (group) => group.includes(candidateMajor) && requiredMajors.some((r) => group.includes(r))
  );
}

/**
 * Major-requirement signal (Phase 1B.6). 'exact' mode can produce
 * ineligible on a non-match. 'related_field' mode is deliberately
 * conservative: it can only ever resolve to eligible (exact or a known
 * related grouping) or unknown — NEVER ineligible — because the tiny
 * related-field table above is known to be incomplete, and a false
 * ineligible from an incomplete taxonomy is a worse failure mode than an
 * honest unknown.
 */
function evaluateMajorSignal(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): EligibilitySignal | null {
  const required = opportunity.requiredMajors;
  if (!required || required.length === 0) return null; // not stated

  const primary = pickPrimaryEducation(candidate.education);
  if (!primary) {
    return { status: "unknown", text: "Major requirement stated but candidate has no education record" };
  }

  const candidateMajor = normalizeMajor(primary.major);
  const requiredNormalized = required.map(normalizeMajor);
  const exactMatch = requiredNormalized.includes(candidateMajor);

  if (exactMatch) {
    return { status: "eligible", text: `Major (${primary.major}) matches the opportunity's required major` };
  }

  if (opportunity.requiredMajorMatchMode === "related_field") {
    if (isRelatedMajor(candidateMajor, requiredNormalized)) {
      return {
        status: "eligible",
        text: `Major (${primary.major}) accepted as related to the opportunity's required field`,
      };
    }
    return {
      status: "unknown",
      text: "Opportunity accepts related fields for its major requirement; candidate's major could not be confidently verified as related",
    };
  }

  // 'exact' mode (or unspecified match mode with a required list present)
  // and no match.
  return {
    status: "ineligible",
    text: `Opportunity requires a major in [${required.join(", ")}]; candidate's major (${primary.major}) does not match`,
  };
}

/**
 * Graduation-timing eligibility signal (Phase 1B.6). Generalizes the
 * single-deadline comparison already used by the education SCORE
 * component into an independent, bounded eligibility axis with both an
 * optional floor and ceiling.
 */
function evaluateGraduationSignal(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): EligibilitySignal | null {
  if (opportunity.graduationNotBefore === null && opportunity.graduationNotAfter === null) {
    return null; // not stated
  }

  const primary = pickPrimaryEducation(candidate.education);
  if (!primary || primary.expectedGraduationDate === null) {
    return {
      status: "unknown",
      text: "Graduation requirement stated but candidate's expected graduation date is not provided",
    };
  }

  const grad = primary.expectedGraduationDate;
  if (opportunity.graduationNotBefore !== null && grad < opportunity.graduationNotBefore) {
    return {
      status: "ineligible",
      text: `Opportunity requires graduation no earlier than ${opportunity.graduationNotBefore}; candidate's expected graduation (${grad}) is earlier`,
    };
  }
  if (opportunity.graduationNotAfter !== null && grad > opportunity.graduationNotAfter) {
    return {
      status: "ineligible",
      text: `Opportunity requires graduation no later than ${opportunity.graduationNotAfter}; candidate's expected graduation (${grad}) is later`,
    };
  }
  return {
    status: "eligible",
    text: `Expected graduation (${grad}) satisfies the opportunity's graduation timing requirement`,
  };
}

/**
 * Enrollment-status requirement signal (Phase 1B.6).
 */
function evaluateEnrollmentSignal(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): EligibilitySignal | null {
  const required = opportunity.requiredEnrollmentStatuses;
  if (!required || required.length === 0) return null; // not stated

  const primary = pickPrimaryEducation(candidate.education);
  if (!primary) {
    return { status: "unknown", text: "Enrollment status requirement stated but candidate has no education record" };
  }
  if (required.includes(primary.enrollmentStatus)) {
    return {
      status: "eligible",
      text: `Enrollment status (${primary.enrollmentStatus}) meets the opportunity's requirement`,
    };
  }
  return {
    status: "ineligible",
    text: `Opportunity requires enrollment status in [${required.join(", ")}]; candidate's status (${primary.enrollmentStatus}) does not match`,
  };
}

interface EligibilityResult {
  eligibility: EligibilityStatus;
  reasons: string[];
  missing: string[];
  unknown: string[];
}

function computeEligibility(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): EligibilityResult {
  const reasons: string[] = [];
  const missing: string[] = [];
  const unknown: string[] = [];

  // Each evaluator independently returns a signal or null ("not stated,
  // no signal for this axis") — see the section header comment above for
  // the full semantics. jurisdictionCountry itself never produces a
  // standalone signal (per the design doc: "store and pass through as
  // context, do not invent immigration/legal rules merely from
  // jurisdictionCountry") — it is only consulted inside
  // evaluateExistingWorkAuthorizationSignal's one narrow, bounded rule.
  const signals: EligibilitySignal[] = [
    evaluateSponsorshipSignal(candidate, opportunity), // unconditional, see its own doc comment
    evaluateEligibleCountriesSignal(candidate, opportunity),
    evaluateCitizenshipRequirementSignal(candidate, opportunity),
    evaluateExistingWorkAuthorizationSignal(candidate, opportunity),
    evaluateDegreeSignal(candidate, opportunity),
    evaluateMajorSignal(candidate, opportunity),
    evaluateGraduationSignal(candidate, opportunity),
    evaluateEnrollmentSignal(candidate, opportunity),
  ].filter((s): s is EligibilitySignal => s !== null);

  if (signals.length === 0) {
    // Defensive branch per the Phase 1B.6 design doc's combination rule
    // ("if zero eligibility signals exist at all → unknown"). In practice
    // this is rarely reached, since evaluateSponsorshipSignal always
    // produces a signal whenever any work_authorization row exists — but
    // it is the correct, honest answer if it ever is reached (e.g. a
    // hypothetical future caller that omits sponsorship evaluation
    // entirely), rather than defaulting to eligible.
    unknown.push("No eligibility requirements stated by this opportunity, and no eligibility data available to evaluate");
    return { eligibility: "unknown", reasons, missing, unknown };
  }

  for (const signal of signals) {
    if (signal.status === "eligible") reasons.push(signal.text);
    else if (signal.status === "ineligible") missing.push(signal.text);
    else unknown.push(signal.text);
  }

  let eligibility: EligibilityStatus;
  if (signals.some((s) => s.status === "ineligible")) {
    eligibility = "ineligible";
  } else if (signals.some((s) => s.status === "unknown")) {
    eligibility = "unknown";
  } else {
    eligibility = "eligible";
  }

  return { eligibility, reasons, missing, unknown };
}

// ── Top-level entry point ───────────────────────────────────────────────

/**
 * Pure deterministic candidate/opportunity match. No I/O of any kind.
 *
 * Deterministic: identical inputs always produce identical output — no
 * randomness, no current-time dependency (unlike buildTodayView, this
 * function needs no injected `now`, since none of its scoring or
 * eligibility rules depend on today's date — only on relationships
 * between dates already present in the input).
 */
export function matchCandidate(
  candidate: CandidateMatchInput,
  opportunity: OpportunityMatchInput
): MatchResult {
  const { skillsScore, projectsScore, reasons: skillReasons, missing: skillMissing } =
    computeSkillsAndProjects(candidate, opportunity);

  const education = computeEducation(candidate, opportunity);
  const experience = computeExperience(candidate, opportunity);
  const eligibilityResult = computeEligibility(candidate, opportunity);

  const breakdown: MatchBreakdown = {
    skills: skillsScore,
    education: education.score,
    experience: experience.score,
    projects: projectsScore,
  };

  const score = breakdown.skills + breakdown.education + breakdown.experience + breakdown.projects;

  const reasons = [...skillReasons, ...education.reasons, ...experience.reasons, ...eligibilityResult.reasons];
  const missing = [...skillMissing, ...education.missing, ...experience.missing, ...eligibilityResult.missing];
  const unknown = [...education.unknown, ...eligibilityResult.unknown];

  return {
    score,
    eligibility: eligibilityResult.eligibility,
    breakdown,
    reasons,
    missing,
    unknown,
  };
}