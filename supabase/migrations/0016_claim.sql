-- 0016_claim.sql
-- Phase 0 / Day 4 — Claim entity with ClaimStatus lifecycle (Claims domain).
--
-- Design approved against docs/candidate-truth-layer-phase0.md §1 (the
-- ClaimStatus table) and §3/§9 (Claim is evidence-linked, atomic,
-- status-gated). Fields not fully specified by that doc (subject_entity_type
-- values, Claim<->EvidenceSource cardinality, where trust_tier lives, the
-- SUPERSEDED replacement link direction) were proposed and approved
-- separately — see the design-approval discussion for the reasoning per
-- field. Summary of the decisions this migration encodes:
--   - candidate_id is denormalized onto claim (not derived through
--     subject_entity_id) purely so RLS ownership uses the same simple
--     pattern as every other table.
--   - subject_entity_id has NO database-level foreign key. This isn't a
--     shortcut — docs/candidate-truth-layer-phase0.md Day 4 explicitly
--     says the polymorphic link is "the application-layer integrity check
--     (validate on write, plus a script for the orphan-check, run manually
--     for now rather than as a cron job)". Postgres cannot FK across
--     multiple target tables from one column, so this was always meant to
--     be app-layer, not a gap being papered over here.
--   - evidence_source_id is nullable and single (one evidence per claim,
--     not a join table) — a tier_3_self_attested claim legitimately has no
--     evidence at all, and Phase 0 has no case requiring multiple evidence
--     sources per claim.
--   - trust_tier is NOT a stored column anywhere — it's computed at query
--     time (no evidence -> tier_3_self_attested; document_upload evidence
--     -> tier_2_document; github_repository evidence with
--     owner_verified = true -> tier_1_verified). This avoids a second
--     source of truth that could drift from the evidence it describes,
--     the same "compute, don't maintain" discipline the doc already
--     applies to used_in_applications_count (§8).
--   - superseded_by_claim_id is set on the OLD claim, pointing to the NEW
--     one that replaced it (old -> new), so "find the current version" is
--     a simple forward walk from any historical claim.
--
-- Claims are never hard-deleted (doc: "SUPERSEDED and REVOKED claims are
-- never deleted") — there is deliberately no DELETE RLS policy on this
-- table, which means delete is denied entirely, for every role except
-- service_role.
--
-- Status transitions are enforced by a BEFORE INSERT OR UPDATE trigger
-- (not a plain CHECK constraint, which cannot see the previous value) per
-- the exact transition table in docs/candidate-truth-layer-phase0.md §1:
--   DRAFT      -> CONFIRMED | REVOKED | SUPERSEDED
--   CONFIRMED  -> DISPUTED | SUPERSEDED | REVOKED
--   DISPUTED   -> CONFIRMED | SUPERSEDED | REVOKED
--   SUPERSEDED, REVOKED: terminal, no outgoing transitions
-- Nothing ever transitions back into DRAFT. Same-status updates (ordinary
-- field edits that don't change status) are always allowed.

create table if not exists public.claim (
  id                    uuid primary key default gen_random_uuid(),
  candidate_id          uuid not null references public.candidate(id) on delete cascade,
  subject_entity_type   text not null
                          check (subject_entity_type in (
                            'education', 'work_authorization', 'skill', 'project',
                            'experience', 'achievement', 'certification'
                          )),
  subject_entity_id     uuid not null,
  claim_text            text not null check (btrim(claim_text) <> ''),
  status                text not null default 'DRAFT'
                          check (status in ('DRAFT', 'CONFIRMED', 'DISPUTED', 'SUPERSEDED', 'REVOKED')),
  evidence_source_id    uuid references public.evidence_source(id) on delete set null,
  superseded_by_claim_id uuid references public.claim(id) on delete set null,
  last_reviewed_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint claim_not_self_superseding check (
    superseded_by_claim_id is null or superseded_by_claim_id <> id
  )
);

comment on table public.claim is
  'Claims domain. Never hard-deleted (no DELETE RLS policy). trust_tier is '
  'not stored here — computed at query time from the linked evidence_source. '
  'subject_entity_id has no DB-level FK by design (polymorphic; see '
  'docs/candidate-truth-layer-phase0.md Day 4 for the app-layer integrity '
  'check this implies).';

create index if not exists idx_claim_candidate_id on public.claim(candidate_id);
create index if not exists idx_claim_subject_entity on public.claim(subject_entity_type, subject_entity_id);
create index if not exists idx_claim_evidence_source_id on public.claim(evidence_source_id);

drop trigger if exists trg_claim_updated_at on public.claim;
create trigger trg_claim_updated_at
  before update on public.claim
  for each row
  execute function public.set_updated_at();

-- ── ClaimStatus transition enforcement ──────────────────────────────────

create or replace function public.check_claim_status_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'CONFIRMED' then
      new.last_reviewed_at := coalesce(new.last_reviewed_at, now());
    end if;
    return new;
  end if;

  -- UPDATE: ordinary field edits that don't change status are always fine.
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'DRAFT' and new.status in ('CONFIRMED', 'REVOKED', 'SUPERSEDED') then
    -- allowed
  elsif old.status = 'CONFIRMED' and new.status in ('DISPUTED', 'SUPERSEDED', 'REVOKED') then
    -- allowed
  elsif old.status = 'DISPUTED' and new.status in ('CONFIRMED', 'SUPERSEDED', 'REVOKED') then
    -- allowed
  else
    raise exception 'invalid ClaimStatus transition: % -> %', old.status, new.status
      using errcode = '23514'; -- surfaces as a check_violation, consistent with other domain rules
  end if;

  if new.status = 'CONFIRMED' then
    new.last_reviewed_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_claim_status_transition on public.claim;
create trigger trg_claim_status_transition
  before insert or update on public.claim
  for each row
  execute function public.check_claim_status_transition();

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Read/insert/update follow the same ownership-through-candidate pattern
-- as every other table. No DELETE policy exists at all — see comment above.

alter table public.claim enable row level security;
alter table public.claim force row level security;

drop policy if exists claim_select_own on public.claim;
create policy claim_select_own
  on public.claim
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = claim.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists claim_insert_own on public.claim;
create policy claim_insert_own
  on public.claim
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = claim.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists claim_update_own on public.claim;
create policy claim_update_own
  on public.claim
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = claim.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = claim.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
