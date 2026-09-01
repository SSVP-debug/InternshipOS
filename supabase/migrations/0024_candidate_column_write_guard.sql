-- 0024_candidate_column_write_guard.sql
-- Round 23 follow-up. candidate_update_own (0005_rls_policies.sql) has
-- always allowed an authenticated candidate to UPDATE any column of their
-- own candidate row — there was no column-level restriction, because
-- nothing in the API layer ever wrote to this table from a request-serving
-- path until Round 23 added POST /profile's auto-activation and PATCH
-- /profile/status (routes/profile.ts), both of which only ever write
-- profile_status. That made the policy's full breadth a live gap rather
-- than a theoretical one: a candidate with a valid JWT, hitting PostgREST
-- directly (bypassing the Express API's own validation), could still write
-- to id, auth_user_id, created_at, or data_retention_ack_at.
--
-- Fixed the same way status-transition legality is enforced elsewhere in
-- this schema (0016_claim.sql, 0018_application.sql) — a BEFORE UPDATE
-- trigger, not a policy rewrite, since RLS policies can't inspect
-- individual column diffs between OLD and NEW. service_role (the trusted
-- backend/ingestion path — current_user = 'service_role' when connected
-- via the service-role key on a real Supabase project; see
-- tests/local_auth_shim.sql for how the local test harness simulates the
-- same role) is exempt, matching every other trigger of this shape.
--
-- profile_status and data_retention_ack_at are the only two columns a
-- non-service-role UPDATE may change:
--   - profile_status: the entire reason this guard exists — see PATCH
--     /profile/status.
--   - data_retention_ack_at: a candidate acknowledging a data-retention
--     notice is a legitimate self-service write, even though no route
--     currently sets it (the same "defined but not yet wired up" status
--     profile_status itself had before Round 23 — left alone rather than
--     locked down, since blocking it wouldn't fix anything today and
--     would just be a second speculative decision layered on this one).
-- id, auth_user_id, and created_at are never client-writable: id is the
-- primary key every other table's RLS/FKs key off of; auth_user_id already
-- has a WITH CHECK guard preventing reassignment to a DIFFERENT user, but
-- this trigger makes it immutable outright rather than merely
-- non-hijackable; created_at is a record of fact, not something a client
-- has any legitimate reason to rewrite.

create or replace function public.check_candidate_column_write()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'service_role' then
    return new;
  end if;

  if new.id is distinct from old.id
    or new.auth_user_id is distinct from old.auth_user_id
    or new.created_at is distinct from old.created_at
  then
    raise exception
      'candidate.id, auth_user_id, and created_at cannot be changed by this role';
  end if;

  return new;
end;
$$;

comment on function public.check_candidate_column_write() is
  'BEFORE UPDATE guard on public.candidate: non-service-role callers may '
  'only change profile_status and data_retention_ack_at. id/auth_user_id/'
  'created_at are immutable outside the trusted backend path. See '
  '0024_candidate_column_write_guard.sql header for why.';

drop trigger if exists trg_candidate_column_write_guard on public.candidate;
create trigger trg_candidate_column_write_guard
  before update on public.candidate
  for each row
  execute function public.check_candidate_column_write();
