// profileFieldOptions.ts
//
// Dropdown option lists for Profile page enum fields. Every list here is
// deliberately kept in exact sync with the backend's Zod schemas (source
// of truth) in api/src/lib/schemas.ts, which in turn mirror the DB check
// constraints in their corresponding migration — see the comment above
// each constant below for the exact schema it must match.
//
// BUG THIS FILE FIXES: prior to this file existing, profile.ts had its own
// hand-written option lists for these five fields, and every one of them
// had drifted from the backend's actual enum — e.g. Work Authorization
// offered "Visa Holder"/"Requires Sponsorship"/"Other", none of which the
// backend accepts (it wants f1_opt/needs_sponsorship/etc.), so selecting
// any of the three most common real-world values guaranteed a 400 on
// save. Education's degree_type was a free-text input entirely, though
// the backend requires a strict enum. This file is the single place those
// values now live, so the "form allows a choice the backend rejects"
// failure mode can't silently reappear for these fields without a visible,
// intentional edit here.
//
// No imports, no side effects — pure data, safe to import from a test file
// with no DOM/browser environment.

export type OptionList = [value: string, label: string][];

// Mirrors WorkAuthorizationRequestSchema.status (api/src/lib/schemas.ts),
// which mirrors the check constraint in 0008_work_authorization.sql.
export const WORK_AUTH_STATUS_OPTIONS: OptionList = [
  ["us_citizen", "U.S. Citizen"],
  ["permanent_resident", "Permanent Resident"],
  ["f1_opt", "F-1 OPT"],
  ["f1_cpt", "F-1 CPT"],
  ["stem_opt_eligible", "STEM OPT Eligible"],
  ["h1b", "H-1B"],
  ["other_visa", "Other Visa"],
  ["needs_sponsorship", "Needs Sponsorship"],
  ["not_applicable_non_us", "Not Applicable (Non-U.S.)"],
];

// Mirrors EducationRequestSchema.degree_type, which mirrors the check
// constraint in 0007_education.sql.
export const EDUCATION_DEGREE_TYPE_OPTIONS: OptionList = [
  ["associate", "Associate's"],
  ["bachelor", "Bachelor's"],
  ["master", "Master's"],
  ["phd", "PhD"],
  ["bootcamp", "Bootcamp"],
  ["other", "Other"],
];

// Mirrors EducationRequestSchema.enrollment_status, which mirrors the
// check constraint in 0007_education.sql.
export const EDUCATION_ENROLLMENT_STATUS_OPTIONS: OptionList = [
  ["current", "Current"],
  ["graduated", "Graduated"],
  ["on_leave", "On leave"],
  ["transferred", "Transferred"],
  ["withdrawn", "Withdrawn"],
];

// Mirrors SkillRequestSchema.category, which mirrors the check constraint
// in 0009_skill.sql.
export const SKILL_CATEGORY_OPTIONS: OptionList = [
  ["language", "Language"],
  ["framework", "Framework"],
  ["tool", "Tool"],
  ["domain", "Domain"],
  ["soft_skill", "Soft skill"],
];

// Mirrors SkillRequestSchema.self_rating (optional), which mirrors the
// check constraint in 0009_skill.sql.
export const SKILL_SELF_RATING_OPTIONS: OptionList = [
  ["exposed", "Exposed"],
  ["proficient", "Proficient"],
  ["advanced", "Advanced"],
];
