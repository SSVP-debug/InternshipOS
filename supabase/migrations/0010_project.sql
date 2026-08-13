-- 0010_project.sql
-- Phase 0 / Day 2 — Project entity only (Candidate-facts domain).
--
-- Per docs/candidate-truth-layer-phase0.md: Project is a "build now" entity.
-- Fields match the approved architecture exactly:
--   id, candidate_id, title, description, role, team_size, start_date,
--   end_date, is_ongoing, tech_stack, external_url
--
-- Deliberately NOT included here (per this task's scope and the approved
-- architecture):
--   - GitHubRepository — a separate entity linked to Project, not a field
--     on it. Not implemented in this migration; no GitHub verification/sync
--     of any kind exists here.
--   - Any "verified"/"evidence_backed" flag on Project itself — the
--     architecture never puts verification status on Project directly.
--     Project facts stay structural/self-attested; verification lives
--     entirely in the future Claim + EvidenceSource entities, which are
--     NOT created here. A project's title/description being stored is not
--     itself a claim of truth — nothing here marks project statements as
--     verified, automatically or otherwise.
--
-- tech_stack "references Skill.name where possible" per the architecture
-- doc, but that's an informal/soft reference for later matching use, not
-- an enforced foreign key — stored as plain text[], same as the doc
-- describes it, with no join to public.skill.
--
-- Follows the same conventions established in 0007_education.sql /
-- 0009_skill.sql: uuid pk, candidate_id fk with on delete cascade,
-- set_updated_at() trigger, RLS enabled+forced with the
-- ownership-through-candidate subquery pattern, table + policies
-- co-located in one migration.

create table if not exists public.project (
  id                 uuid primary key default gen_random_uuid(),
  candidate_id       uuid not null references public.candidate(id) on delete cascade,
  title              text not null check (btrim(title) <> ''),
  description        text not null check (btrim(description) <> ''),
  role               text,
  team_size          integer check (team_size is null or team_size > 0),
  start_date         date,
  end_date           date,
  is_ongoing         boolean not null default false,
  tech_stack         text[] not null default '{}',
  external_url       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Temporal validation, same convention as education's grad-date checks.
  constraint project_end_after_start
    check (end_date is null or start_date is null or end_date >= start_date),
  -- A project marked ongoing cannot also have a fixed end_date — the two
  -- are contradictory. is_ongoing = false places no constraint on end_date
  -- (a finished project may simply not have recorded one).
  constraint project_ongoing_has_no_end_date
    check (is_ongoing = false or end_date is null)
);

comment on table public.project is
  'Candidate-facts domain. Structural/self-attested project facts only — '
  'no verification status lives here. Claims/EvidenceSource (Phase 1+) are '
  'what will later back specific statements about a project; this table '
  'never marks anything as verified on its own.';

drop trigger if exists trg_project_updated_at on public.project;
create trigger trg_project_updated_at
  before update on public.project
  for each row
  execute function public.set_updated_at();

create index if not exists idx_project_candidate_id on public.project(candidate_id);

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table public.project enable row level security;
alter table public.project force row level security;

drop policy if exists project_select_own on public.project;
create policy project_select_own
  on public.project
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = project.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists project_insert_own on public.project;
create policy project_insert_own
  on public.project
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = project.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists project_update_own on public.project;
create policy project_update_own
  on public.project
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = project.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = project.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists project_delete_own on public.project;
create policy project_delete_own
  on public.project
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = project.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
