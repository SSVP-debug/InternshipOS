-- 0007_education.sql
-- Phase 0 / Day 2 — Education entity only (Candidate-facts domain).
--
-- Per docs/candidate-truth-layer-phase0.md §3 (Phase 0 minimum viable
-- schema): Education is one of the "build now" entities, structural fields
-- only — no Claim-linked bullet content here, that's a later phase.
--
-- Follows the same conventions established in 0002-0006:
--   - uuid pk, candidate_id fk with on delete cascade
--   - public.set_updated_at() trigger (defined in 0002_candidate.sql)
--   - RLS enabled + forced, ownership-through-candidate subquery pattern
--   - table + its own RLS policies co-located in one migration, since this
--     is a single self-contained new entity (unlike Day 1, where multiple
--     Day-1 tables shared one RLS migration)

create table if not exists public.education (
  id                          uuid primary key default gen_random_uuid(),
  candidate_id                uuid not null references public.candidate(id) on delete cascade,
  institution_name            text not null,
  institution_country         text not null,
  degree_type                 text not null
                                 check (degree_type in ('associate','bachelor','master','phd','bootcamp','other')),
  major                       text not null,
  minor                       text,
  -- gpa_scale is mandatory whenever gpa_value is present — a bare "3.8" is
  -- meaningless across international institutions (approved architecture,
  -- Candidate Truth Layer doc §2.3). Enforced here AND at the API layer
  -- (belt-and-braces, same pattern as personal_info's email check).
  gpa_value                   numeric,
  gpa_scale                   numeric,
  start_date                  date not null,
  expected_graduation_date    date,
  actual_graduation_date      date,
  enrollment_status           text not null
                                 check (enrollment_status in ('current','graduated','on_leave','transferred','withdrawn')),
  is_primary                  boolean not null default false,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint education_gpa_scale_required_with_value
    check (gpa_value is null or gpa_scale is not null),
  constraint education_gpa_value_nonnegative
    check (gpa_value is null or gpa_value >= 0),
  constraint education_gpa_value_within_scale
    check (gpa_value is null or gpa_scale is null or gpa_value <= gpa_scale),
  constraint education_gpa_scale_positive
    check (gpa_scale is null or gpa_scale > 0),

  -- Temporal validation rules (approved architecture, "Temporal" section):
  -- expected/actual graduation date must be >= start_date. Overlapping
  -- Education date ranges across rows are explicitly NOT constrained here
  -- (dual-degree / transfer students are valid, per the design doc's edge
  -- cases) — only within-row ordering is enforced.
  constraint education_expected_grad_after_start
    check (expected_graduation_date is null or expected_graduation_date >= start_date),
  constraint education_actual_grad_after_start
    check (actual_graduation_date is null or actual_graduation_date >= start_date)
);

comment on table public.education is
  'Candidate-facts domain. Structural fields only — no Claim-linked '
  'accomplishment content in Phase 0.';

drop trigger if exists trg_education_updated_at on public.education;
create trigger trg_education_updated_at
  before update on public.education
  for each row
  execute function public.set_updated_at();

create index if not exists idx_education_candidate_id on public.education(candidate_id);

-- At most one is_primary = true row per candidate (multiple Education rows
-- are fully supported — is_primary marks which one drives default
-- grad-date-based matching later, per the approved architecture).
create unique index if not exists uq_education_primary_per_candidate
  on public.education(candidate_id)
  where is_primary;

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table public.education enable row level security;
alter table public.education force row level security;

drop policy if exists education_select_own on public.education;
create policy education_select_own
  on public.education
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = education.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists education_insert_own on public.education;
create policy education_insert_own
  on public.education
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = education.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists education_update_own on public.education;
create policy education_update_own
  on public.education
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = education.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = education.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists education_delete_own on public.education;
create policy education_delete_own
  on public.education
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = education.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
