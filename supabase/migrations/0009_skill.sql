-- 0009_skill.sql
-- Phase 0 / Day 2 — Skill entity only (Candidate-facts domain).
--
-- Per docs/candidate-truth-layer-phase0.md: Skill is a "build now" entity.
-- Fields match the approved architecture exactly:
--   id, candidate_id, name, category, self_rating, evidence_backed
--
-- evidence_backed is described in the architecture as "computed: does >=1
-- Claim about this skill exist?" — but the Claim entity does not exist yet
-- (deferred past Phase 0, same as ResumeVariant/Application/OutcomeEvent
-- per the approved doc's §3 scope table). So in Phase 0 this column exists,
-- defaults to false, and is NOT settable via the API — there is nothing
-- for it to be computed from yet. Same treatment the architecture doc
-- prescribes for other "will be computed later" fields (e.g.
-- used_in_applications_count in the Truth Center design).
--
-- self_rating is kept (approved schema requires it) but is informational
-- only in Phase 0 — not read by any matching/scoring logic, none of which
-- exists yet anyway.
--
-- No skill-taxonomy/normalization service is built here, per the task's
-- explicit instruction. Duplicate prevention instead uses a simple
-- generated, normalized column (lowercased + trimmed) with a unique index
-- — enough to stop "React" / "react " / " REACT" from being recorded as
-- three separate skills, without a taxonomy management system.
--
-- Follows the same conventions established in 0007_education.sql: uuid pk,
-- candidate_id fk with on delete cascade, set_updated_at() trigger, RLS
-- enabled+forced with the ownership-through-candidate subquery pattern,
-- table + policies co-located in one migration.

create table if not exists public.skill (
  id                 uuid primary key default gen_random_uuid(),
  candidate_id       uuid not null references public.candidate(id) on delete cascade,
  name               text not null check (btrim(name) <> ''),
  category           text not null
                       check (category in ('language','framework','tool','domain','soft_skill')),
  self_rating        text
                       check (self_rating is null or self_rating in ('exposed','proficient','advanced')),
  evidence_backed    boolean not null default false,
  -- Simple normalization (not a taxonomy service): lowercase + trim, used
  -- only for duplicate detection within one candidate's own skill list.
  name_normalized    text generated always as (lower(btrim(name))) stored,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.skill is
  'Candidate-facts domain. evidence_backed defaults to false and is not '
  'API-writable in Phase 0 — no Claim entity exists yet to compute it from.';

drop trigger if exists trg_skill_updated_at on public.skill;
create trigger trg_skill_updated_at
  before update on public.skill
  for each row
  execute function public.set_updated_at();

create index if not exists idx_skill_candidate_id on public.skill(candidate_id);

-- Duplicate prevention: same normalized name for the same candidate is
-- rejected, regardless of category — a candidate should not be able to
-- record "React" as both a framework and a tool under two separate rows.
create unique index if not exists uq_skill_candidate_name_normalized
  on public.skill(candidate_id, name_normalized);

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table public.skill enable row level security;
alter table public.skill force row level security;

drop policy if exists skill_select_own on public.skill;
create policy skill_select_own
  on public.skill
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = skill.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists skill_insert_own on public.skill;
create policy skill_insert_own
  on public.skill
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = skill.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists skill_update_own on public.skill;
create policy skill_update_own
  on public.skill
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = skill.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = skill.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists skill_delete_own on public.skill;
create policy skill_delete_own
  on public.skill
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = skill.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
