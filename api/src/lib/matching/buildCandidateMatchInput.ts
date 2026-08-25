// buildCandidateMatchInput.ts
//
// Pure mapper: raw rows from the 5 candidate-owned tables (skill,
// education, experience, project, work_authorization) into
// matchEngine.ts's CandidateMatchInput. No Supabase calls, no I/O of
// any kind — same "logic separated from I/O" discipline as
// matchEngine.ts and todayView.ts. runMatchingForCandidate.ts is the
// only caller responsible for actually fetching these rows.
//
// PRIVACY BOUNDARY: input row shapes below are typed to exactly the
// columns each existing route already selects (EDUCATION_COLUMNS,
// SKILL_COLUMNS, EXPERIENCE_COLUMNS, PROJECT_COLUMNS, WORK_AUTH_COLUMNS
// in api/src/routes/*.ts) — none of which include name, email, phone, or
// any public.personal_info field. This module additionally never reads
// candidate.name or personal_info.location_country even by omission of a
// type field: those fields simply have no representation in the raw row
// types below, so there is nothing for this mapper to accidentally pass
// through. CandidateMatchInput itself already has no slot for them (see
// matchEngine.ts's own privacy boundary comment).
//
// NEVER DEFAULT/INVENT: this mapper performs field renaming only. It
// never fabricates a value matchEngine.ts would treat as a real signal —
// missing work_authorization becomes `null` (matching the route's own
// 404 semantics), never a guessed WorkAuthorizationSignal.

import type {
  CandidateEducationSignal,
  CandidateExperienceSignal,
  CandidateMatchInput,
  CandidateProjectSignal,
  CandidateSkillSignal,
  WorkAuthorizationSignal,
} from "../matchEngine.js";

/** Raw shape of one row from `select(SKILL_COLUMNS)` in api/src/routes/skill.ts (fields this mapper uses only). */
export interface RawSkillRow {
  name: string;
}

/** Raw shape of one row from `select(EDUCATION_COLUMNS)` in api/src/routes/education.ts (fields this mapper uses only). */
export interface RawEducationRow {
  degree_type: CandidateEducationSignal["degreeType"];
  major: string;
  enrollment_status: CandidateEducationSignal["enrollmentStatus"];
  expected_graduation_date: string | null;
  is_primary: boolean;
}

/** Raw shape of one row from `select(EXPERIENCE_COLUMNS)` in api/src/routes/experience.ts (fields this mapper uses only). */
export interface RawExperienceRow {
  employment_type: CandidateExperienceSignal["employmentType"];
  is_current: boolean;
}

/** Raw shape of one row from `select(PROJECT_COLUMNS)` in api/src/routes/project.ts (fields this mapper uses only). */
export interface RawProjectRow {
  tech_stack: string[];
}

/** Raw shape of the row from `select(WORK_AUTH_COLUMNS)` in api/src/routes/work-authorization.ts (fields this mapper uses only). */
export interface RawWorkAuthorizationRow {
  status: WorkAuthorizationSignal["status"];
  requires_sponsorship: boolean;
  citizenship_country: string;
}

export interface BuildCandidateMatchInputParams {
  skills: RawSkillRow[];
  education: RawEducationRow[];
  experience: RawExperienceRow[];
  projects: RawProjectRow[];
  /**
   * `null` = no public.work_authorization row exists for this candidate
   * (mirrors GET /work-authorization's 404 — see
   * api/src/routes/work-authorization.ts). The caller must pass `null`
   * here rather than an empty object; this mapper does not itself decide
   * what "missing" looks like, it only relays what the caller found.
   */
  workAuthorization: RawWorkAuthorizationRow | null;
}

/**
 * Maps raw candidate-owned rows into matchEngine.ts's CandidateMatchInput.
 * Pure field renaming — no filtering, no defaulting, no inference.
 * Enum values (degree_type, enrollment_status, employment_type, status)
 * are passed through unchanged; their vocabularies already match
 * matchEngine.ts's types exactly (same check constraints as
 * 0007_education.sql, 0008_work_authorization.sql, 0011_experience.sql).
 */
export function buildCandidateMatchInput(params: BuildCandidateMatchInputParams): CandidateMatchInput {
  const skills: CandidateSkillSignal[] = params.skills.map((row) => ({
    name: row.name,
  }));

  const education: CandidateEducationSignal[] = params.education.map((row) => ({
    degreeType: row.degree_type,
    major: row.major,
    enrollmentStatus: row.enrollment_status,
    expectedGraduationDate: row.expected_graduation_date,
    isPrimary: row.is_primary,
  }));

  const experience: CandidateExperienceSignal[] = params.experience.map((row) => ({
    employmentType: row.employment_type,
    isCurrent: row.is_current,
  }));

  const projects: CandidateProjectSignal[] = params.projects.map((row) => ({
    techStack: row.tech_stack,
  }));

  const workAuthorization: WorkAuthorizationSignal | null = params.workAuthorization
    ? {
        status: params.workAuthorization.status,
        requiresSponsorship: params.workAuthorization.requires_sponsorship,
        citizenshipCountry: params.workAuthorization.citizenship_country,
      }
    : null;

  return { skills, education, experience, projects, workAuthorization };
}
