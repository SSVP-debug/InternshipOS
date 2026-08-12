-- 0002_candidate.sql
-- Phase 0 / Day 1 — Candidate root entity.
-- References auth.users(id), which is provided by Supabase Auth (GoTrue) on
-- a real Supabase project. This migration assumes that table already exists.
-- (Local test harness provides an equivalent shim — see tests/local_auth_shim.sql,
-- which is intentionally NOT part of this migrations/ directory.)

create table if not exists public.candidate (
  id                      uuid primary key default gen_random_uuid(),
  auth_user_id            uuid not null unique references auth.users(id) on delete cascade,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  profile_status          text not null default 'incomplete'
                             check (profile_status in ('incomplete','active','paused','archived')),
  data_retention_ack_at   timestamptz
);

comment on table public.candidate is
  'Root candidate identity. No PII here by design — see personal_info.';

-- keep updated_at current on every write
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_candidate_updated_at on public.candidate;
create trigger trg_candidate_updated_at
  before update on public.candidate
  for each row
  execute function public.set_updated_at();

create index if not exists idx_candidate_auth_user_id on public.candidate(auth_user_id);
