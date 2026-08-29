-- test_opportunity_source_access.sql
-- Phase 1A test suite: opportunity_source — the system-owned catalog table
-- (0022_opportunity_intelligence_foundation.sql). NOT candidate-owned, so
-- this suite is NOT an ownership test like the others in this directory —
-- it verifies the narrower "read-only active rows for any authenticated
-- user, write access to nobody but service_role" contract the table's own
-- migration comment documents.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own auth user), does not depend on or modify
-- any other test suite. Writes rows the way service-role ingestion would —
-- as the connecting superuser role, which (like service_role) bypasses RLS
-- entirely, rather than as 'authenticated', since authenticated has no
-- INSERT grant on this table at all (see local_auth_shim_grants.sql).

\set ON_ERROR_STOP on
\echo '--- Setting up one auth.user + signup provisioning, and three opportunity_source rows (active/expired/removed) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  cand_a_id uuid;
  active_id uuid;
  expired_id uuid;
  removed_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'src-alice@example.edu');
  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;

  if cand_a_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  -- Inserted as the connecting (superuser) role, not 'authenticated' —
  -- mirrors how service-role ingestion actually writes this table in
  -- production; RLS is bypassed the same way for both.
  insert into public.opportunity_source (source_type, title, company, dedup_fingerprint, status)
  values ('job_board', 'Backend Engineering Intern', 'Acme Corp', 'src-test-active-1', 'active')
  returning id into active_id;

  insert into public.opportunity_source (source_type, title, company, dedup_fingerprint, status)
  values ('job_board', 'Old Data Intern Listing', 'Beta Inc', 'src-test-expired-1', 'expired')
  returning id into expired_id;

  insert into public.opportunity_source (source_type, title, company, dedup_fingerprint, status)
  values ('job_board', 'Pulled Listing', 'Gamma LLC', 'src-test-removed-1', 'removed')
  returning id into removed_id;

  create temporary table src_test_ids (key text primary key, val uuid);
  insert into src_test_ids values
    ('user_a', user_a_id), ('cand_a', cand_a_id),
    ('active', active_id), ('expired', expired_id), ('removed', removed_id);
end $$;

\echo '--- Test 1: authenticated user CAN read an active opportunity_source row ---'
do $$
declare v_uid uuid; v_active_id uuid; v_count int;
begin
  select val into v_uid from src_test_ids where key = 'user_a';
  select val into v_active_id from src_test_ids where key = 'active';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.opportunity_source where id = v_active_id;
  reset role;
  if v_count != 1 then
    raise exception 'FAIL: authenticated user could not read an active opportunity_source row (count=%)', v_count;
  end if;
  raise notice 'PASS: authenticated user can read an active opportunity_source row';
end $$;

\echo '--- Test 2: authenticated user CANNOT read an expired opportunity_source row ---'
do $$
declare v_uid uuid; v_expired_id uuid; v_count int;
begin
  select val into v_uid from src_test_ids where key = 'user_a';
  select val into v_expired_id from src_test_ids where key = 'expired';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.opportunity_source where id = v_expired_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: authenticated user could read an expired opportunity_source row (count=%)', v_count;
  end if;
  raise notice 'PASS: authenticated user cannot read an expired opportunity_source row';
end $$;

\echo '--- Test 3: authenticated user CANNOT read a removed opportunity_source row ---'
do $$
declare v_uid uuid; v_removed_id uuid; v_count int;
begin
  select val into v_uid from src_test_ids where key = 'user_a';
  select val into v_removed_id from src_test_ids where key = 'removed';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.opportunity_source where id = v_removed_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: authenticated user could read a removed opportunity_source row (count=%)', v_count;
  end if;
  raise notice 'PASS: authenticated user cannot read a removed opportunity_source row';
end $$;

\echo '--- Test 4: an inactive row becoming active is immediately visible (status is the only gate, not a snapshot) ---'
do $$
declare v_uid uuid; v_expired_id uuid; v_count int;
begin
  update public.opportunity_source set status = 'active' where id = (select val from src_test_ids where key = 'expired');

  select val into v_uid from src_test_ids where key = 'user_a';
  select val into v_expired_id from src_test_ids where key = 'expired';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.opportunity_source where id = v_expired_id;
  reset role;

  -- restore it for later tests in this file
  update public.opportunity_source set status = 'expired' where id = v_expired_id;

  if v_count != 1 then
    raise exception 'FAIL: a row flipped to active was not immediately visible (count=%)', v_count;
  end if;
  raise notice 'PASS: opportunity_source visibility follows current status, not a cached/snapshotted state';
end $$;

\echo '--- Test 5: authenticated user CANNOT INSERT into opportunity_source (no policy + no grant — ingestion is service-role only) ---'
do $$
declare v_uid uuid; failed boolean := false;
begin
  select val into v_uid from src_test_ids where key = 'user_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.opportunity_source (source_type, title, company, dedup_fingerprint)
    values ('manual_seed', 'Should Not Insert', 'Nobody Inc', 'src-test-should-not-insert-1');
  exception when insufficient_privilege then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: authenticated user was able to INSERT into opportunity_source';
  end if;
  raise notice 'PASS: authenticated user cannot INSERT into opportunity_source';
end $$;

\echo '--- Test 6: authenticated user CANNOT UPDATE an opportunity_source row ---'
do $$
declare v_uid uuid; v_active_id uuid; failed boolean := false;
begin
  select val into v_uid from src_test_ids where key = 'user_a';
  select val into v_active_id from src_test_ids where key = 'active';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    update public.opportunity_source set title = 'Tampered Title' where id = v_active_id;
  exception when insufficient_privilege then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: authenticated user was able to UPDATE an opportunity_source row';
  end if;
  raise notice 'PASS: authenticated user cannot UPDATE an opportunity_source row';
end $$;

\echo '--- Test 7: authenticated user CANNOT DELETE an opportunity_source row ---'
do $$
declare v_uid uuid; v_active_id uuid; failed boolean := false;
begin
  select val into v_uid from src_test_ids where key = 'user_a';
  select val into v_active_id from src_test_ids where key = 'active';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    delete from public.opportunity_source where id = v_active_id;
  exception when insufficient_privilege then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: authenticated user was able to DELETE an opportunity_source row';
  end if;
  raise notice 'PASS: authenticated user cannot DELETE an opportunity_source row';
end $$;

\echo '--- Test 8: anon role cannot read ANY opportunity_source rows, active or not ---'
do $$
declare v_count int;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.opportunity_source;
  exception when insufficient_privilege then
    v_count := -1;
  end;
  reset role;
  if v_count > 0 then
    raise exception 'FAIL: anon role could read opportunity_source rows (count=%)', v_count;
  end if;
  raise notice 'PASS: anon role reads zero opportunity_source rows (denied at grant or RLS layer)';
end $$;

\echo '--- ALL OPPORTUNITY_SOURCE TESTS PASSED ---'
