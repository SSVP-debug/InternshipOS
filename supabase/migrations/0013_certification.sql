-- 0013_certification.sql
-- Phase 0 / Day 2 — Certification entity only (Candidate-facts domain).
--
-- Fields match the approved architecture exactly (Candidate Truth Layer
-- design, §2.10 — referenced but not fully repeated in
-- docs/candidate-truth-layer-phase0.md's Phase-0 scope table, which lists
-- Certification as "as designed", same situation as Achievement in 0012):
--   id, candidate_id, name, issuer, issue_date, expiry_date, credential_id,
--   verification_url
--
-- No enum-valued fields exist on this entity. No credibility, ranking,
-- score, or verification-status field is added — verification_url is a
-- plain stored link (self-attested tier), same discipline already applied
-- to Achievement (0012). No Claim or EvidenceSource rows are created here;
-- a Certification row is a structural fact, not a claim of truth.
--
-- Per the approved architecture's validation-rules section: "Certification
-- with a passed expiry_date is retained (it happened) but excluded by
-- default from generated content unless the student explicitly overrides —
-- expired certs shouldn't silently appear as current." That exclusion
-- logic belongs to a later phase (generation doesn't exist yet); this
-- migration only stores the dates needed to support it later.
--
-- Follows the same conventions established in 0009_skill.sql /
-- 0010_project.sql / 0011_experience.sql / 0012_achievement.sql: uuid pk,
-- candidate_id fk with on delete cascade, set_updated_at() trigger, RLS
-- enabled+forced with the ownership-through-candidate subquery pattern,
-- table + policies co-located in one migration.

create table if not exists public.certification (
  id                 uuid primary key default gen_random_uuid(),
  candidate_id       uuid not null references public.candidate(id) on delete cascade,
  name               text not null check (btrim(name) <> ''),
  issuer             text not null check (btrim(issuer) <> ''),
  issue_date         date not null,
  expiry_date        date,
  credential_id      text,
  verification_url   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Sensible temporal validation, same convention already established for
  -- Education/Project/Experience (end/expiry must not precede the start
  -- date) — a data-consistency safeguard on the existing date fields, not
  -- a new field.
  constraint certification_expiry_after_issue
    check (expiry_date is null or expiry_date >= issue_date)
);

comment on table public.certification is
  'Candidate-facts domain. verification_url is a plain self-attested link, '
  'not a verified-status flag — no credibility/ranking/score/verification '
  'field exists on this table. No Claim or EvidenceSource rows are created '
  'here; a passed expiry_date is retained, not deleted or auto-flagged.';

drop trigger if exists trg_certification_updated_at on public.certification;
create trigger trg_certification_updated_at
  before update on public.certification
  for each row
  execute function public.set_updated_at();

create index if not exists idx_certification_candidate_id on public.certification(candidate_id);

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table public.certification enable row level security;
alter table public.certification force row level security;

drop policy if exists certification_select_own on public.certification;
create policy certification_select_own
  on public.certification
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = certification.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists certification_insert_own on public.certification;
create policy certification_insert_own
  on public.certification
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = certification.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists certification_update_own on public.certification;
create policy certification_update_own
  on public.certification
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = certification.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = certification.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists certification_delete_own on public.certification;
create policy certification_delete_own
  on public.certification
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = certification.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
