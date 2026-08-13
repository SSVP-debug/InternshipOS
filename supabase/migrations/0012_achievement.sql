-- 0012_achievement.sql
-- Phase 0 / Day 2 — Achievement entity only (Candidate-facts domain).
--
-- Fields match the approved architecture exactly (Candidate Truth Layer
-- design, §2.9 — referenced but not fully repeated in
-- docs/candidate-truth-layer-phase0.md's Phase-0 scope table, which lists
-- Achievement as "as designed"):
--   id, candidate_id, title, issuing_body, date_awarded, rank_or_result,
--   verification_url
--
-- No enum-valued fields exist on this entity. verification_url is a plain
-- stored link (self-attested tier) — not a verified-status flag, and this
-- migration does not invent one. No Claim or EvidenceSource rows are
-- created here; an Achievement row is a structural fact, same discipline
-- already applied to Project (0010) and Experience (0011).
--
-- Follows the same conventions established in 0009_skill.sql /
-- 0010_project.sql / 0011_experience.sql: uuid pk, candidate_id fk with on
-- delete cascade, set_updated_at() trigger, RLS enabled+forced with the
-- ownership-through-candidate subquery pattern, table + policies
-- co-located in one migration.

create table if not exists public.achievement (
  id                 uuid primary key default gen_random_uuid(),
  candidate_id       uuid not null references public.candidate(id) on delete cascade,
  title              text not null check (btrim(title) <> ''),
  issuing_body       text,
  date_awarded       date not null,
  rank_or_result     text,
  verification_url   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.achievement is
  'Candidate-facts domain. verification_url is a plain self-attested link, '
  'not a verified-status flag — no verification/credibility field exists '
  'on this table. No Claim or EvidenceSource rows are created here.';

drop trigger if exists trg_achievement_updated_at on public.achievement;
create trigger trg_achievement_updated_at
  before update on public.achievement
  for each row
  execute function public.set_updated_at();

create index if not exists idx_achievement_candidate_id on public.achievement(candidate_id);

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table public.achievement enable row level security;
alter table public.achievement force row level security;

drop policy if exists achievement_select_own on public.achievement;
create policy achievement_select_own
  on public.achievement
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = achievement.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists achievement_insert_own on public.achievement;
create policy achievement_insert_own
  on public.achievement
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = achievement.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists achievement_update_own on public.achievement;
create policy achievement_update_own
  on public.achievement
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = achievement.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = achievement.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists achievement_delete_own on public.achievement;
create policy achievement_delete_own
  on public.achievement
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = achievement.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
