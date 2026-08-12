-- 0004_consent_record.sql
-- Phase 0 / Day 1 — ConsentRecord (privacy layer).
-- Granular by consent_type per the approved architecture — data_processing
-- consent is required to create a profile; other types (github_oauth_access,
-- llm_processing, document_upload_storage) are recorded when their features
-- ship in later phases, but the type enum is defined now so no migration is
-- needed later to add them.

create table if not exists public.consent_record (
  id             uuid primary key default gen_random_uuid(),
  candidate_id   uuid not null references public.candidate(id) on delete cascade,
  consent_type   text not null
                   check (consent_type in (
                     'data_processing',
                     'github_oauth_access',
                     'llm_processing',
                     'document_upload_storage'
                   )),
  granted_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  version        text not null,
  constraint consent_revoked_after_granted check (revoked_at is null or revoked_at >= granted_at)
);

comment on table public.consent_record is
  'Append-mostly consent ledger. A consent is revoked via revoked_at, never deleted.';

create index if not exists idx_consent_record_candidate_id on public.consent_record(candidate_id);

-- One CURRENTLY-ACTIVE (unrevoked) consent per (candidate, type) — re-consenting
-- after a revocation inserts a new row rather than mutating history.
create unique index if not exists uq_consent_active_per_type
  on public.consent_record(candidate_id, consent_type)
  where revoked_at is null;
