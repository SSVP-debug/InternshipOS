-- 0030_application_ats_submission.sql
-- Gate R8 — tracking columns for real external-ATS submission
-- (api/src/lib/ats/leverAdapter.ts, POST /applications/:id/submit-to-ats).
--
-- Per docs/gate-r8-lever-ats-submission.md: this is a deliberate,
-- narrow reversal of the prior Gate R0 decision that real form-
-- submission/browser automation was out of scope — scoped to Lever's
-- public postings-apply endpoint only (the one ATS with a genuinely
-- public, no-employer-credential-needed submission API), feature-flagged
-- off by default (EXTERNAL_ATS_SUBMISSION_ENABLED), and defaulting to
-- dry-run per request even when the flag is on. See that doc for the
-- full reasoning; this migration only adds the columns the route needs
-- to record what happened.
--
-- No new table: this is a small, single-purpose extension of the
-- existing application row, same posture as 0027_application_resume.sql
-- adding resume_id directly to application rather than a side table.
-- ats_provider is nullable/unconstrained-enum-for-now (a plain text
-- column, not a CHECK-constrained enum) because Lever is the only value
-- that will ever be written today, and a second provider is genuinely
-- speculative until it exists — narrower than adding a CHECK for a
-- one-member set.

alter table public.application
  add column if not exists ats_provider text,
  add column if not exists ats_external_id text,
  add column if not exists ats_submitted_at timestamptz,
  add column if not exists ats_submission_error text;

comment on column public.application.ats_provider is
  'Which ATS this application was actually submitted through by '
  'POST /applications/:id/submit-to-ats, e.g. ''lever''. NULL means never '
  'attempted (including every application created before Gate R8, and '
  'every application whose opportunity/resume/personal_info never passed '
  'that route''s preconditions).';

comment on column public.application.ats_external_id is
  'The employer ATS''s own identifier for the submitted application, '
  'when the ATS''s response includes one. Lever''s public apply endpoint '
  'does not reliably return one in every case, so this is commonly NULL '
  'even after a successful submission — a NULL here is not itself '
  'evidence anything went wrong; ats_submitted_at is the source of truth '
  'for whether submission succeeded.';

comment on column public.application.ats_submitted_at is
  'When the external submission actually succeeded (Lever returned a '
  '2xx). Distinct from application.applied_at (set by the status-'
  'transition trigger whenever status becomes APPLIED, including the '
  'ordinary manual/tracking-only path that predates this gate) — the two '
  'will usually be set together by submit-to-ats''s own status update, '
  'but applied_at can be set without ats_submitted_at (manual tracking) '
  'while the reverse should never happen.';

comment on column public.application.ats_submission_error is
  'The most recent submission failure message, if the last attempt '
  'failed. Cleared (set back to NULL) on the next successful attempt. '
  'Deliberately NOT an append-only log — a single "here''s what went '
  'wrong last time" field is enough for a candidate retrying a failed '
  'submission; a full history would need its own table (like '
  'application_status_event) and nothing here has asked for that yet.';

-- No RLS changes needed: these columns live on the existing
-- public.application table, which already has application_update_own
-- (0018_application.sql) covering the caller's own rows via their
-- normal user-scoped client — the same policy that already governs
-- every other field update on this table.
