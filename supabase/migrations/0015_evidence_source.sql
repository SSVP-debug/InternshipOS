-- 0015_evidence_source.sql
-- Phase 0 / Day 3 — EvidenceSource entity (Evidence domain).
--
-- Design approved against docs/candidate-truth-layer-phase0.md, revision 2.
-- That doc references a prior/v1 design for EvidenceSource's exact schema
-- which is not present in this repo; the columns below were proposed from
-- everything the current doc *does* establish (candidate-scoped ownership,
-- file_ref vs. external ref, owner_verified only via GitHub OAuth, no
-- checksum per §8) and approved before this migration was written — see
-- the design-approval discussion for the full reasoning per field.
--
-- Two source types only (document_upload, github_repository) — not a
-- generic external_url type. The doc only ever describes uploaded files
-- and GitHub as evidence sources; adding a broader type now would be
-- exactly the speculative hardening §8 says to cut. Additive to extend
-- later (new enum value + new nullable columns), same pattern as every
-- other Phase 0 entity.
--
-- checksum is deliberately NOT included — §8 explicitly cuts it for
-- Phase 0 ("real concern eventually... but... speculative hardening").
--
-- Follows the same conventions as 0009_skill.sql / 0013_certification.sql:
-- uuid pk, candidate_id fk with on delete cascade, set_updated_at()
-- trigger, RLS enabled+forced with the ownership-through-candidate
-- subquery pattern, table + policies co-located in one migration.

create table if not exists public.evidence_source (
  id                 uuid primary key default gen_random_uuid(),
  candidate_id       uuid not null references public.candidate(id) on delete cascade,
  source_type        text not null
                       check (source_type in ('document_upload', 'github_repository')),
  title              text not null check (btrim(title) <> ''),
  file_ref           text,
  external_url       text,
  owner_verified     boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Exactly one of file_ref / external_url is set, matching source_type.
  -- Same style as education_gpa_scale_required_with_value /
  -- project_ongoing_has_no_end_date in prior migrations.
  constraint evidence_source_ref_matches_type check (
    (source_type = 'document_upload' and file_ref is not null and external_url is null)
    or
    (source_type = 'github_repository' and external_url is not null and file_ref is null)
  )
);

comment on table public.evidence_source is
  'Evidence domain. owner_verified is settable to true only by the GitHub '
  'OAuth verification flow (Day 3) — never by a self-upload. Never read by '
  'LLM calls directly (docs/candidate-truth-layer-phase0.md §5/§6).';

drop trigger if exists trg_evidence_source_updated_at on public.evidence_source;
create trigger trg_evidence_source_updated_at
  before update on public.evidence_source
  for each row
  execute function public.set_updated_at();

create index if not exists idx_evidence_source_candidate_id on public.evidence_source(candidate_id);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Per docs/candidate-truth-layer-phase0.md §5/§6: evidence is never read by
-- LLM calls directly, and access is scoped per candidate_id. No dedicated
-- LLM-boundary policy exists at the RLS layer for this table (there is no
-- separate "LLM service role" distinct from service_role in this schema) —
-- the boundary is enforced at the application layer via the single
-- claims-for-LLM serializer described in §5, which never queries this
-- table at all. RLS here only needs to enforce candidate ownership.

alter table public.evidence_source enable row level security;
alter table public.evidence_source force row level security;

drop policy if exists evidence_source_select_own on public.evidence_source;
create policy evidence_source_select_own
  on public.evidence_source
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = evidence_source.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists evidence_source_insert_own on public.evidence_source;
create policy evidence_source_insert_own
  on public.evidence_source
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = evidence_source.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists evidence_source_update_own on public.evidence_source;
create policy evidence_source_update_own
  on public.evidence_source
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = evidence_source.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = evidence_source.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists evidence_source_delete_own on public.evidence_source;
create policy evidence_source_delete_own
  on public.evidence_source
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = evidence_source.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
