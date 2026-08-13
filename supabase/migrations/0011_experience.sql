-- 0011_experience.sql
-- Phase 0 / Day 2 — Experience entity only (Candidate-facts domain).
--
-- Per docs/candidate-truth-layer-phase0.md: Experience is a "build now"
-- entity. Fields match the approved architecture exactly:
--   id, candidate_id, organization, title, employment_type, start_date,
--   end_date, is_current, location, description_raw
--
-- Per the approved architecture's own note on Experience: "Bullet-level
-- accomplishments are NOT stored as a text blob here — each accomplishment
-- worth using in an application is its own Claim linked to this Experience."
-- description_raw is explicitly "the student's own draft" (self-attested
-- tier) — it is NOT a Claim, and this migration creates no Claim or
-- EvidenceSource rows of any kind. No verification/credibility field is
-- invented here either — same discipline already applied to Project in
-- 0010_project.sql: an Experience row is a structural fact, not a claim of
-- truth, and nothing here marks it as verified.
--
-- Follows the same conventions established in 0007_education.sql /
-- 0009_skill.sql / 0010_project.sql: uuid pk, candidate_id fk with on
-- delete cascade, set_updated_at() trigger, RLS enabled+forced with the
-- ownership-through-candidate subquery pattern, table + policies
-- co-located in one migration.

create table if not exists public.experience (
  id                 uuid primary key default gen_random_uuid(),
  candidate_id       uuid not null references public.candidate(id) on delete cascade,
  organization       text not null check (btrim(organization) <> ''),
  title              text not null check (btrim(title) <> ''),
  employment_type    text not null
                       check (employment_type in ('internship','part_time','full_time','research','volunteer')),
  start_date         date not null,
  end_date           date,
  is_current         boolean not null default false,
  location           text,
  description_raw    text not null check (btrim(description_raw) <> ''),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Temporal validation, per the approved architecture's Temporal section:
  -- "Experience.end_date (if present) must be >= start_date; is_current =
  -- true requires end_date IS NULL." Same convention as
  -- project_end_after_start / project_ongoing_has_no_end_date in
  -- 0010_project.sql.
  constraint experience_end_after_start
    check (end_date is null or end_date >= start_date),
  constraint experience_current_has_no_end_date
    check (is_current = false or end_date is null)

  -- Deliberately NOT enforced: overlapping Experience date ranges across
  -- different rows. Per the approved architecture: "Overlapping Experience
  -- date ranges are a warning, not an error — dual part-time roles and
  -- concurrent research + internship are common and valid." No cross-row
  -- constraint is added for this reason.
);

comment on table public.experience is
  'Candidate-facts domain. description_raw is the student''s own draft '
  '(self-attested tier) — accomplishment-level Claims linked to an '
  'Experience are a later phase, not created here. No verification or '
  'credibility field exists on this table.';

drop trigger if exists trg_experience_updated_at on public.experience;
create trigger trg_experience_updated_at
  before update on public.experience
  for each row
  execute function public.set_updated_at();

create index if not exists idx_experience_candidate_id on public.experience(candidate_id);

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table public.experience enable row level security;
alter table public.experience force row level security;

drop policy if exists experience_select_own on public.experience;
create policy experience_select_own
  on public.experience
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = experience.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists experience_insert_own on public.experience;
create policy experience_insert_own
  on public.experience
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = experience.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists experience_update_own on public.experience;
create policy experience_update_own
  on public.experience
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = experience.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = experience.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists experience_delete_own on public.experience;
create policy experience_delete_own
  on public.experience
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = experience.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
