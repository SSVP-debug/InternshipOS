// schemas.ts
// Request validation, deliberately separated from route handlers so it can
// be unit tested with no network/Supabase dependency (see tests/schemas.test.ts).

import { z } from "zod";

export const SignupRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "password must be at least 8 characters"),
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

// Mirrors personal_info's NOT NULL / check constraints from
// 0003_personal_info.sql — validated at the API boundary too, so a bad
// request fails fast with a clear message instead of a raw Postgres error.
export const PersonalInfoRequestSchema = z.object({
  legal_first_name: z.string().min(1),
  legal_last_name: z.string().min(1),
  preferred_name: z.string().optional(),
  email: z.string().email(),
  phone: z.string().optional(),
  location_city: z.string().optional(),
  location_country: z.string().min(1),
  pronouns: z.string().optional(),
});
export type PersonalInfoRequest = z.infer<typeof PersonalInfoRequestSchema>;

// consent_type mirrors the check constraint in 0004_consent_record.sql.
export const ConsentRequestSchema = z.object({
  consent_type: z.enum([
    "data_processing",
    "github_oauth_access",
    "llm_processing",
    "document_upload_storage",
  ]),
});
export type ConsentRequest = z.infer<typeof ConsentRequestSchema>;

// ── Education (Day 2) ───────────────────────────────────────────────────
// Mirrors the check constraints in 0007_education.sql — validated at the
// API boundary too, same "fail fast with a clear message" pattern used for
// personal_info. The .refine() calls duplicate the DB's temporal + GPA
// constraints deliberately (belt-and-braces, not a replacement for them).

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const EducationRequestSchema = z
  .object({
    institution_name: z.string().min(1),
    institution_country: z.string().min(1),
    degree_type: z.enum(["associate", "bachelor", "master", "phd", "bootcamp", "other"]),
    major: z.string().min(1),
    minor: z.string().optional(),
    gpa_value: z.number().nonnegative().optional(),
    gpa_scale: z.number().positive().optional(),
    start_date: dateString,
    expected_graduation_date: dateString.optional(),
    actual_graduation_date: dateString.optional(),
    enrollment_status: z.enum(["current", "graduated", "on_leave", "transferred", "withdrawn"]),
    is_primary: z.boolean().optional().default(false),
  })
  .refine((data) => data.gpa_value === undefined || data.gpa_scale !== undefined, {
    message: "gpa_scale is required whenever gpa_value is provided",
    path: ["gpa_scale"],
  })
  .refine(
    (data) => data.gpa_value === undefined || data.gpa_scale === undefined || data.gpa_value <= data.gpa_scale,
    { message: "gpa_value cannot exceed gpa_scale", path: ["gpa_value"] }
  )
  .refine(
    (data) =>
      data.expected_graduation_date === undefined ||
      data.expected_graduation_date >= data.start_date,
    { message: "expected_graduation_date must be on or after start_date", path: ["expected_graduation_date"] }
  )
  .refine(
    (data) =>
      data.actual_graduation_date === undefined || data.actual_graduation_date >= data.start_date,
    { message: "actual_graduation_date must be on or after start_date", path: ["actual_graduation_date"] }
  );
export type EducationRequest = z.infer<typeof EducationRequestSchema>;

export const UuidParamSchema = z.string().uuid();

// ── WorkAuthorization (Day 2) ───────────────────────────────────────────
// Mirrors the check constraint + NOT NULL fields in 0008_work_authorization.sql.
// requires_sponsorship is required (not defaulted) — it must be stored
// explicitly per the task requirements, never inferred from `status`.

export const WorkAuthorizationRequestSchema = z.object({
  citizenship_country: z.string().min(1),
  status: z.enum([
    "us_citizen",
    "permanent_resident",
    "f1_opt",
    "f1_cpt",
    "stem_opt_eligible",
    "h1b",
    "other_visa",
    "needs_sponsorship",
    "not_applicable_non_us",
  ]),
  requires_sponsorship: z.boolean(),
  work_auth_expiry_date: dateString.optional(),
  notes: z.string().optional(),
});
export type WorkAuthorizationRequest = z.infer<typeof WorkAuthorizationRequestSchema>;
