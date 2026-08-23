-- 0023_country_neutral_eligibility.sql
-- Opportunity Intelligence — Phase 1B.6: Country-Neutral Eligibility Model.
--
-- Approved design: "Country-Neutral Eligibility Model — Design Document"
-- (Phase 1B.6). Adds ONLY nullable, additive structured eligibility-
-- requirement columns to public.opportunity_source. No other table is
-- touched: public.opportunity, public.opportunity_match, public.application,
-- public.application_status_event, and public.application_note are all
-- unmodified by this migration, and no existing opportunity_source column
-- is altered.
--
-- WHY THESE COLUMNS EXIST (see the design doc for full reasoning):
-- Both Phase 1B.5 reality tests (14 real US/international postings, 13
-- real India-market postings) showed the matcher's skill/education/
-- experience/project scoring is country-neutral, but its eligibility
-- logic was not: work_authorization.status is a US-immigration-shaped
-- enum, and the only citizenship-parsing path was a literal English
-- phrase list ("us citizen" / "u.s. citizen" / "united states citizen").
-- Real Indian postings never used that pattern at all, and instead
-- commonly gate on degree, major/branch, and graduation year/batch —
-- none of which opportunity_source had any structured field for. These
-- columns replace ad-hoc free-text parsing with structured, country-
-- neutral comparison, without hardcoding any country-specific enum.
--
-- Every column is nullable. NULL means "this requirement was not stated
-- by the opportunity" and is handled by the matcher as "no signal for
-- this axis" (see api/src/lib/matchEngine.ts) — never coerced to a
-- pass/fail. This mirrors the tri-state discipline already established
-- for sponsorship_offered in 0022_opportunity_intelligence_foundation.sql.

alter table public.opportunity_source
  add column if not exists jurisdiction_country text,
  add column if not exists eligible_candidate_countries text[],
  add column if not exists citizenship_required_countries text[],
  add column if not exists requires_existing_work_authorization boolean,
  add column if not exists required_degree_types text[],
  add column if not exists required_majors text[],
  add column if not exists required_major_match_mode text
    check (required_major_match_mode in ('exact', 'related_field')),
  add column if not exists graduation_not_before date,
  add column if not exists graduation_not_after date,
  add column if not exists required_enrollment_statuses text[];

comment on column public.opportunity_source.jurisdiction_country is
  'Country whose work-authorization law governs this role (usually where '
  'the work is legally performed). Free-form country identifier, not an '
  'enum — deliberately extensible without a schema change per new '
  'country. NULL = not stated; matching code must not infer a default.';

comment on column public.opportunity_source.eligible_candidate_countries is
  'Explicit allow-list of candidate citizenship countries this '
  'opportunity accepts, when the posting states one. NULL/empty = '
  'unrestricted or unstated — this is NOT the same as "restricted to no '
  'one"; the matcher must not treat NULL as a blocking signal.';

comment on column public.opportunity_source.citizenship_required_countries is
  'Structured replacement for free-text citizenship-restriction parsing '
  '(e.g. "must be a U.S. citizen" becomes {us}). Country-neutral by '
  'construction: works identically for any country''s citizenship '
  'requirement, not just US postings. NULL = no structured citizenship '
  'requirement stated.';

comment on column public.opportunity_source.requires_existing_work_authorization is
  'Tri-state, same discipline as sponsorship_offered: true = candidate '
  'must already hold the right to work in jurisdiction_country without '
  'any employer action; false = explicitly not required; NULL = not '
  'stated. Distinct from sponsorship_offered — a posting can require '
  'pre-existing authorization while remaining agnostic about how '
  '(citizenship, permanent residency, an existing visa, etc).';

comment on column public.opportunity_source.required_degree_types is
  'Required minimum degree level(s), using the same vocabulary as '
  'public.education.degree_type (associate/bachelor/master/phd/'
  'bootcamp/other) — no new enum introduced. NULL = not stated.';

comment on column public.opportunity_source.required_majors is
  'Required field(s) of study, free text (e.g. "Computer Science", '
  '"CSE"). Matched against candidate education.major per '
  'required_major_match_mode. NULL = not stated.';

comment on column public.opportunity_source.required_major_match_mode is
  'How required_majors should be compared: ''exact'' = candidate major '
  'must match one of the listed values; ''related_field'' = a '
  'conservative, small related-field allowance is permitted (see '
  'matchEngine.ts — deliberately not a general academic taxonomy). NULL '
  'when required_majors is NULL.';

comment on column public.opportunity_source.graduation_not_before is
  'Earliest acceptable expected graduation date, if the opportunity '
  'states a floor. NULL = no lower bound stated.';

comment on column public.opportunity_source.graduation_not_after is
  'Latest acceptable expected graduation date, if the opportunity states '
  'a ceiling (e.g. "must graduate by 2026" style requirements, common in '
  'real Indian internship postings per the Phase 1B.5 India reality '
  'test). NULL = no upper bound stated.';

comment on column public.opportunity_source.required_enrollment_statuses is
  'Required enrollment status(es), using the same vocabulary as '
  'public.education.enrollment_status (current/graduated/on_leave/'
  'transferred/withdrawn) — no new enum introduced. NULL = not stated.';

-- ── No RLS changes ──────────────────────────────────────────────────────
-- These are additive columns on an existing table; the existing
-- opportunity_source_select_active policy (0022_opportunity_intelligence_
-- foundation.sql) already covers SELECT on all columns of a row an
-- authenticated user can see, and there is still no INSERT/UPDATE/DELETE
-- policy for the authenticated role (writes remain service-role only, as
-- established in 0022). No policy is created, dropped, or modified here.

-- ── No other tables touched ─────────────────────────────────────────────
-- public.opportunity, public.opportunity_match, public.application,
-- public.application_status_event, and public.application_note are
-- unchanged by this migration.