// matchEngine.ts
// Pure deterministic matching engine for Opportunity Intelligence Phase 1B.
// Source of truth for field availability: the Phase 1B candidate-data
// audit (Skills/Education/Experience/Projects/WorkAuthorization sections).
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
//   exactly such a matching code path.
//
// WORK AUTHORIZATION SEMANTICS:
//   CandidateMatchInput.workAuthorization is `WorkAuthorizationSignal | null`.
//   `null` means "no public.work_authorization row exists for this
//   candidate" (mirrors the API's own 404 work_authorization_not_found —
//   see api/src/routes/work-authorization.ts). This is never defaulted to
//   eligible or ineligible; see computeEligibility below.
//
// OPPORTUNITY sponsorship_offered SEMANTICS:
//   OpportunityMatchInput.sponsorshipOffered is `boolean | null`, mirroring
//   opportunity_source.sponsorship_offered exactly (0022_opportunity_
//   intelligence_foundation.sql: "NULL means unknown... must never be
//   treated as 'no sponsorship'"). `null` is never coerced to `false`
//   anywhere in this file.

import { normalizeSkillList } from "./skillNormalization.js";

// ── Input contract ──────────────────────────────────────────────────────
// Field selection here matches the Phase 1B audit's proposed
// CandidateMatchInput / OpportunityMatchInput exactly (§E/§F of that
// audit). Do not widen these types to include personal_info fields —
// see the privacy boundary note above.

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
  /** public.work_authorization.status */
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
  /** opportunity_source.citizenship_requirement — free text, nullable. */
  citizenshipRequirement: string | null;
  /** opportunity_source.deadline_date (YYYY-MM-DD), nullable. */
  deadlineDate: string | null;
}

// ── Output contract ─────────────────────────────────────────────────────

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
// Chosen from what the repository's data can actually justify (see the
// Phase 1B audit). Documented rationale per component:
//
//   skills     (45 pts) — the ONLY domain with a directly comparable
//                          structured field on both sides
//                          (candidate skill.name vs opportunity_source.skills).
//                          Given the highest weight because it is the
//                          strongest, most literal signal available.
//   education  (25 pts) — degree_type/major/enrollment_status/expected_
//                          graduation_date are real structured candidate
//                          fields, but opportunity_source has NO matching
//                          structured education-requirement field at all
//                          (confirmed by the audit — no required_degree /
//                          required_major column exists). This component
//                          is therefore an intrinsic readiness signal
//                          (is this candidate currently a student, on
//                          track to still be enrolled by the deadline),
//                          not a true candidate-vs-opportunity match.
//                          Documented explicitly as an assumption below.
//   experience (15 pts) — only employment_type and current/duration are
//                          structured (audit §A.3); description_raw is
//                          NOT used for skill inference in this v1 engine.
//   projects   (15 pts) — project.tech_stack is structured and directly
//                          comparable to opportunity_source.skills, but to
//                          avoid double-counting a skill already credited
//                          via the skills component, this component only
//                          credits skills found in tech_stack that are
//                          NOT already present in the candidate's declared
//                          skill list (see computeSkillsAndProjects below).
//
// Total: 45 + 25 + 15 + 15 = 100.
export const SKILLS_WEIGHT = 45;
export const EDUCATION_WEIGHT = 25;
export const EXPERIENCE_WEIGHT = 15;
export const PROJECTS_WEIGHT = 15;

// ── Skills + Projects (combined to avoid double-counting) ───────────────

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

// ── Education ────────────────────────────────────────────────────────────
// See the weights comment above: this is an intrinsic readiness signal,
// not a match against an opportunity-side requirement field (none exists).

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

// ── Experience ───────────────────────────────────────────────────────────

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

// ── Eligibility ──────────────────────────────────────────────────────────
// Only the two deterministic signals the task brief explicitly authorizes:
//   1. work authorization requires sponsorship vs. opportunity's stated
//      sponsorship_offered (tri-state, never coerced).
//   2. A narrow, literal check for an explicit "U.S. citizens only"-style
//      requirement string vs. candidate citizenship status — deliberately
//      NOT a general legal-language parser (task brief: "Do NOT attempt
//      to parse arbitrary legal language aggressively in v1").
//
// Each signal independently resolves to eligible/ineligible/unknown, with
// its own explanation always recorded (reasons/missing/unknown). The
// overall status is then the most conservative of all signals:
// ineligible > unknown > eligible — a single ineligible signal always
// wins, since a clear negative should never be masked by an ambiguous or
// positive one; if nothing is ineligible but something is unknown, the
// overall result stays unknown rather than guessing eligible.

interface EligibilitySignal {
  status: EligibilityStatus;
  text: string;
}

// Deliberately tiny, literal needle list — not a legal-language parser.
const US_CITIZEN_ONLY_PHRASES = ["u.s. citizen", "us citizen", "united states citizen"];
const REQUIREMENT_QUALIFIER_WORDS = ["only", "must be", "required", "requires"];

function evaluateCitizenshipSignal(
  citizenshipRequirement: string | null,
  workAuthorization: WorkAuthorizationSignal
): EligibilitySignal | null {
  if (!citizenshipRequirement || citizenshipRequirement.trim() === "") return null;

  const normalized = citizenshipRequirement.toLowerCase();
  const mentionsUsCitizenship = US_CITIZEN_ONLY_PHRASES.some((phrase) => normalized.includes(phrase));
  const hasQualifier = REQUIREMENT_QUALIFIER_WORDS.some((word) => normalized.includes(word));

  if (mentionsUsCitizenship && hasQualifier) {
    if (workAuthorization.status === "us_citizen") {
      return { status: "eligible", text: "Meets the opportunity's stated U.S. citizenship requirement" };
    }
    return {
      status: "ineligible",
      text: "Opportunity explicitly requires U.S. citizenship; candidate's work authorization status does not indicate citizenship",
    };
  }

  // Citizenship requirement text exists but doesn't match the narrow,
  // literal pattern this v1 engine is willing to act on — reported as
  // unknown rather than guessed at, per the task brief.
  return {
    status: "unknown",
    text: "Citizenship requirement stated but not automatically verifiable in v1",
  };
}

function evaluateSponsorshipSignal(
  workAuthorization: WorkAuthorizationSignal,
  opportunity: OpportunityMatchInput
): EligibilitySignal {
  if (!workAuthorization.requiresSponsorship) {
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

  if (!candidate.workAuthorization) {
    unknown.push("Work authorization not provided");
    return { eligibility: "unknown", reasons, missing, unknown };
  }

  const signals: EligibilitySignal[] = [
    evaluateSponsorshipSignal(candidate.workAuthorization, opportunity),
  ];
  const citizenshipSignal = evaluateCitizenshipSignal(
    opportunity.citizenshipRequirement,
    candidate.workAuthorization
  );
  if (citizenshipSignal) signals.push(citizenshipSignal);

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
 * function needs no injected `now`, since none of its scoring rules
 * depend on today's date — only on the relationship between
 * expectedGraduationDate and the opportunity's own deadlineDate).
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