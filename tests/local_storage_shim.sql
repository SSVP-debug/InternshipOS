-- local_storage_shim.sql
-- LOCAL TEST HARNESS ONLY. Never run against a real Supabase project — the
-- storage schema, storage.objects/storage.buckets, and storage.foldername()
-- already exist there, managed by Supabase's Storage service.
--
-- Same reasoning as local_auth_shim.sql: this recreates just enough of that
-- surface, matching Supabase's real implementation, so that
-- 0021_evidence_storage_bucket.sql (written against the real Supabase
-- storage contract) can be tested against a plain local Postgres instance —
-- specifically the disposable postgres:16 container CI uses, which has no
-- storage extension at all. Applied before migrations run, same as
-- local_auth_shim.sql.
--
-- `if not exists` throughout: when this runs against a real local Supabase
-- CLI stack (`supabase start`) instead of CI's bare postgres:16, the real
-- storage schema already exists and every statement here becomes a no-op.

create schema if not exists storage;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant usage on schema storage to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant usage on schema storage to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema storage to service_role;
  end if;
end
$$;

create table if not exists storage.buckets (
  id                   text primary key,
  name                 text not null,
  owner                uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  public               boolean not null default false,
  avif_autodetection   boolean not null default false,
  file_size_limit      bigint,
  allowed_mime_types   text[]
);

create table if not exists storage.objects (
  id                uuid primary key default gen_random_uuid(),
  bucket_id         text references storage.buckets(id),
  name              text,
  owner             uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_accessed_at  timestamptz not null default now(),
  metadata          jsonb
);

alter table storage.objects enable row level security;
alter table storage.objects force row level security;

-- Matches Supabase's real storage.foldername() implementation: splits the
-- object name on '/' and returns every segment except the last (the
-- filename itself). Pure, deterministic, side-effect-free — CREATE OR
-- REPLACE is safe here even against a real Supabase stack, since our
-- version is behaviorally identical to theirs; flagged in case Supabase
-- ever changes their internal implementation out from under this
-- assumption.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
stable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end
$$;
