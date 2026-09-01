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

// candidate.profile_status mirrors the check constraint in
// 0002_candidate.sql: 'incomplete' | 'active' | 'paused' | 'archived'.
// 'incomplete' is deliberately excluded here — it's the row's initial
// default and is only ever left automatically (on first successful
// POST /profile save, see routes/profile.ts), never a target a candidate
// can PATCH back to. See PATCH /profile/status for the 'archived' ->
// anything block, which this schema alone can't express.
export const ProfileStatusUpdateSchema = z.object({
  profile_status: z.enum(["active", "paused", "archived"]),
});
export type ProfileStatusUpdateRequest = z.infer<typeof ProfileStatusUpdateSchema>;

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

// ── Skill (Day 2) ────────────────────────────────────────────────────────
// Mirrors 0009_skill.sql exactly. evidence_backed is deliberately absent
// from this schema — it's a computed field (per the approved architecture)
// with nothing to compute from until the Claim entity exists, so it is not
// API-writable in Phase 0; the DB default (false) always applies.
// self_rating is kept per the approved schema but is informational only —
// not consumed by any matching/scoring logic in Phase 0.

export const SkillRequestSchema = z.object({
  name: z.string().trim().min(1),
  category: z.enum(["language", "framework", "tool", "domain", "soft_skill"]),
  self_rating: z.enum(["exposed", "proficient", "advanced"]).optional(),
});
export type SkillRequest = z.infer<typeof SkillRequestSchema>;

// ── Project (Day 2) ──────────────────────────────────────────────────────
// Mirrors 0010_project.sql exactly. No verification/evidence field exists
// here by design — project facts stay self-attested and structural in
// Phase 0; nothing about a project is ever auto-marked verified.

export const ProjectRequestSchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    role: z.string().optional(),
    team_size: z.number().int().positive().optional(),
    start_date: dateString.optional(),
    end_date: dateString.optional(),
    is_ongoing: z.boolean().optional().default(false),
    tech_stack: z.array(z.string().trim().min(1)).optional().default([]),
    external_url: z.string().url().optional(),
  })
  .refine(
    (data) => data.end_date === undefined || data.start_date === undefined || data.end_date >= data.start_date,
    { message: "end_date must be on or after start_date", path: ["end_date"] }
  )
  .refine((data) => !data.is_ongoing || data.end_date === undefined, {
    message: "a project marked is_ongoing cannot also have an end_date",
    path: ["end_date"],
  });
export type ProjectRequest = z.infer<typeof ProjectRequestSchema>;

// ── Experience (Day 2) ───────────────────────────────────────────────────
// Mirrors 0011_experience.sql exactly. description_raw is the student's own
// draft (self-attested tier) — no verification/credibility field exists
// here, matching the migration's discipline. Temporal rules mirror
// Project's is_ongoing/end_date pattern: is_current = true cannot coexist
// with an end_date, and end_date (if present) must be >= start_date.

export const ExperienceRequestSchema = z
  .object({
    organization: z.string().trim().min(1),
    title: z.string().trim().min(1),
    employment_type: z.enum(["internship", "part_time", "full_time", "research", "volunteer"]),
    start_date: dateString,
    end_date: dateString.optional(),
    is_current: z.boolean().optional().default(false),
    location: z.string().optional(),
    description_raw: z.string().trim().min(1),
  })
  .refine((data) => data.end_date === undefined || data.end_date >= data.start_date, {
    message: "end_date must be on or after start_date",
    path: ["end_date"],
  })
  .refine((data) => !data.is_current || data.end_date === undefined, {
    message: "an experience marked is_current cannot also have an end_date",
    path: ["end_date"],
  });
export type ExperienceRequest = z.infer<typeof ExperienceRequestSchema>;

// ── Achievement (Day 2) ──────────────────────────────────────────────────
// Mirrors 0012_achievement.sql exactly. verification_url is a plain
// self-attested link — no verification/credibility field is invented here.

export const AchievementRequestSchema = z.object({
  title: z.string().trim().min(1),
  issuing_body: z.string().optional(),
  date_awarded: dateString,
  rank_or_result: z.string().optional(),
  verification_url: z.string().url().optional(),
});
export type AchievementRequest = z.infer<typeof AchievementRequestSchema>;

// ── Certification (Day 2) ────────────────────────────────────────────────
// Mirrors 0013_certification.sql exactly. verification_url is a plain
// self-attested link — no credibility/ranking/score/verification-status
// field is added, matching the migration's discipline.

export const CertificationRequestSchema = z
  .object({
    name: z.string().trim().min(1),
    issuer: z.string().trim().min(1),
    issue_date: dateString,
    expiry_date: dateString.optional(),
    credential_id: z.string().optional(),
    verification_url: z.string().url().optional(),
  })
  .refine((data) => data.expiry_date === undefined || data.expiry_date >= data.issue_date, {
    message: "expiry_date must be on or after issue_date",
    path: ["expiry_date"],
  });
export type CertificationRequest = z.infer<typeof CertificationRequestSchema>;

// ── EvidenceSource (Day 3) ───────────────────────────────────────────────
// Mirrors 0015_evidence_source.sql exactly. owner_verified is never
// API-writable — it is set only by the GitHub OAuth verification flow,
// never by a self-upload, same treatment as skill.evidence_backed.

export const EvidenceSourceRequestSchema = z
  .object({
    source_type: z.enum(["document_upload", "github_repository"]),
    title: z.string().trim().min(1),
    file_ref: z.string().min(1).optional(),
    external_url: z.string().url().optional(),
  })
  .refine(
    (data) =>
      data.source_type === "document_upload"
        ? data.file_ref !== undefined && data.external_url === undefined
        : data.file_ref === undefined && data.external_url !== undefined,
    {
      message:
        "document_upload requires file_ref (and no external_url); github_repository requires external_url (and no file_ref)",
      path: ["source_type"],
    }
  );
export type EvidenceSourceRequest = z.infer<typeof EvidenceSourceRequestSchema>;

// POST /evidence-sources/upload-url (Gate 1a) — the client asks for a
// Storage upload slot before an evidence_source row exists to attach an
// id to (see 0021_evidence_storage_bucket.sql's path-convention comment).
export const UploadUrlRequestSchema = z.object({
  filename: z.string().trim().min(1),
});
export type UploadUrlRequest = z.infer<typeof UploadUrlRequestSchema>;

// ── Claim (Day 4) ────────────────────────────────────────────────────────
// Mirrors 0016_claim.sql. `status` is intentionally NOT part of the create/
// update body schema — status changes go through a dedicated transition
// endpoint (PATCH /claims/:id/status), not a general-purpose field update,
// so the ClaimStatus state machine has exactly one entry point at the API
// layer, mirroring the single DB trigger that enforces it.

export const ClaimRequestSchema = z.object({
  subject_entity_type: z.enum([
    "education",
    "work_authorization",
    "skill",
    "project",
    "experience",
    "achievement",
    "certification",
  ]),
  subject_entity_id: z.string().uuid(),
  claim_text: z.string().trim().min(1),
  evidence_source_id: z.string().uuid().optional(),
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

export const ClaimStatusTransitionSchema = z.object({
  status: z.enum(["CONFIRMED", "DISPUTED", "SUPERSEDED", "REVOKED"]),
});
export type ClaimStatusTransition = z.infer<typeof ClaimStatusTransitionSchema>;

// ── Opportunity (Phase 1) ────────────────────────────────────────────────
// Mirrors 0017_opportunity.sql exactly. inbox_status and is_priority are
// deliberately NOT part of the create/update body — the Opportunity Inbox
// actions (save/dismiss/prioritize) go through a dedicated
// PATCH /opportunities/:id/inbox endpoint instead, same "one entry point
// per state machine" discipline used for Claim's status and, below,
// Application's status.

export const OpportunityRequestSchema = z.object({
  title: z.string().trim().min(1),
  company: z.string().trim().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  work_mode: z.enum(["remote", "hybrid", "onsite"]).optional(),
  employment_type: z.enum(["internship", "co_op", "full_time", "part_time"]).optional().default("internship"),
  skills: z.array(z.string().trim().min(1)).optional().default([]),
  application_url: z.string().url().optional(),
  source: z
    .enum(["manual", "referral", "company_site", "job_board", "career_fair", "other"])
    .optional()
    .default("manual"),
  deadline_date: dateString.optional(),
  posted_date: dateString.optional(),
});
export type OpportunityRequest = z.infer<typeof OpportunityRequestSchema>;

export const OpportunityInboxUpdateSchema = z
  .object({
    inbox_status: z.enum(["new", "saved", "dismissed"]).optional(),
    is_priority: z.boolean().optional(),
    // Set once, by the frontend's Apply flow (see opportunityFeed.ts page),
    // right after it creates the candidate-owned `opportunity`/
    // `application` rows for this match — records which of the
    // candidate's own applications this specific match was promoted into.
    // References public.opportunity(id) (0022_opportunity_intelligence_foundation.sql).
    // Ownership of the referenced opportunity is checked in the route
    // handler (not here — this schema only validates shape), the same
    // "candidate_id belt-and-braces" posture used throughout this file.
    promoted_opportunity_id: z.string().uuid().optional(),
  })
  .refine(
    (data) =>
      data.inbox_status !== undefined || data.is_priority !== undefined || data.promoted_opportunity_id !== undefined,
    {
      message: "at least one of inbox_status, is_priority, or promoted_opportunity_id must be provided",
    },
  );
export type OpportunityInboxUpdate = z.infer<typeof OpportunityInboxUpdateSchema>;

// ── Application (Phase 1) ────────────────────────────────────────────────
// Mirrors 0018_application.sql. `status` is intentionally NOT part of the
// create/update body — status changes go through the dedicated
// PATCH /applications/:id/status endpoint, mirroring Claim's pattern
// exactly (see claim's ClaimRequestSchema comment above).

export const ApplicationCreateRequestSchema = z.object({
  opportunity_id: z.string().uuid(),
  deadline_override: dateString.optional(),
  next_action_date: dateString.optional(),
  next_action_note: z.string().optional(),
  recruiter_name: z.string().optional(),
  recruiter_email: z.string().email().optional(),
});
export type ApplicationCreateRequest = z.infer<typeof ApplicationCreateRequestSchema>;

// PUT body — everything editable except opportunity_id (an application
// doesn't get re-pointed at a different opportunity; withdraw and create a
// new one instead) and status (see above).
export const ApplicationUpdateRequestSchema = z.object({
  deadline_override: dateString.optional(),
  next_action_date: dateString.optional(),
  next_action_note: z.string().optional(),
  recruiter_name: z.string().optional(),
  recruiter_email: z.string().email().optional(),
});
export type ApplicationUpdateRequest = z.infer<typeof ApplicationUpdateRequestSchema>;

export const ApplicationStatusTransitionSchema = z.object({
  status: z.enum(["SAVED", "APPLYING", "APPLIED", "ASSESSMENT", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN"]),
  note: z.string().optional(),
});
export type ApplicationStatusTransition = z.infer<typeof ApplicationStatusTransitionSchema>;

// ── ApplicationNote (Phase 1) ────────────────────────────────────────────
// Mirrors 0020_application_note.sql exactly.

export const ApplicationNoteRequestSchema = z.object({
  note_type: z.enum(["general", "recruiter_contact", "interview", "next_action", "link"]).optional().default("general"),
  content: z.string().trim().min(1),
});
export type ApplicationNoteRequest = z.infer<typeof ApplicationNoteRequestSchema>;
