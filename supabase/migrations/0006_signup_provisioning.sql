-- 0006_signup_provisioning.sql
-- Phase 0 / Day 1 — minimal signup flow, DB half.
--
-- Pattern: auth.users insert (done by Supabase Auth / GoTrue when a user
-- signs up) triggers automatic creation of the matching public.candidate
-- row. This is the standard Supabase "handle_new_user" pattern.
--
-- SECURITY DEFINER is required because this must succeed even though no
-- candidate row (and therefore no RLS-satisfying context) exists yet at the
-- moment of signup. It performs exactly one, narrow, hardcoded insert — it
-- is not a general-purpose bypass.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.candidate (auth_user_id, profile_status)
  values (new.id, 'incomplete')
  on conflict (auth_user_id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_auth_user() is
  'Auto-provisions a candidate row when a new auth.users row is created. '
  'The ONLY security-definer write path in Phase 0 — do not add logic here '
  'beyond this single insert.';

drop trigger if exists trg_handle_new_auth_user on auth.users;
create trigger trg_handle_new_auth_user
  after insert on auth.users
  for each row
  execute function public.handle_new_auth_user();
