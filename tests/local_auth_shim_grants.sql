-- local_auth_shim_grants.sql
-- LOCAL TEST HARNESS ONLY — run after supabase/migrations/*.sql.
-- Mirrors the table-grant defaults Supabase already configures on a real
-- project. RLS policies (0005_rls_policies.sql) do the actual row-level
-- restriction; these are the coarser table-level grants beneath them.

grant select, insert, update on public.candidate, public.personal_info, public.consent_record
  to authenticated;

-- Day 2: Education entity grants (same pattern as Day 1 tables above).
grant select, insert, update, delete on public.education to authenticated;

-- anon gets nothing in Phase 0 — no unauthenticated read/write surface yet.

-- service_role bypasses RLS via the bypassrls role attribute (set in
-- local_auth_shim.sql) and is the only role permitted to act across
-- candidates — used exclusively by trusted backend code (e.g. the signup
-- endpoint's post-provisioning step), never exposed to a client.
grant all on public.candidate, public.personal_info, public.consent_record, public.education
  to service_role;
