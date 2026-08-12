-- local_auth_shim.sql
-- LOCAL TEST HARNESS ONLY. Never run against a real Supabase project — the
-- auth schema, auth.uid(), and the anon/authenticated/service_role roles
-- already exist there, managed by Supabase itself.
--
-- This file recreates just enough of that surface, matching Supabase's real
-- implementation, so that supabase/migrations/*.sql (which is written
-- against the real Supabase auth contract) can be tested against a plain
-- local Postgres instance for free, with no network dependency.

create schema if not exists auth;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text,
  created_at timestamptz not null default now()
);

-- Matches Supabase's real auth.uid() implementation: reads the JWT "sub"
-- claim out of a session GUC that Supabase's PostgREST layer sets per
-- request. Tests below set this GUC directly to simulate "being" a user.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  -- nullif MUST wrap the raw text before the ::json cast — an unset custom
  -- GUC resolves to '' (not NULL) in Postgres, and ''::json throws. This
  -- ordering matches Supabase's real auth.uid() implementation.
  select (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- Table-level grants for public.* tables are applied separately, AFTER the
-- migrations create those tables — see local_auth_shim_grants.sql. (Order
-- matters: this file runs before supabase/migrations/*, which is when the
-- tables and auth.uid() dependency actually get created.)
