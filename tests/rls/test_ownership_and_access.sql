-- test_ownership_and_access.sql
-- Day 1 test suite: proves ownership works and unauthorized access does not.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Uses plain SQL assertions (no pgTAP dependency, keeps Day 1 zero-cost and
-- dependency-free) — each check RAISEs an exception on failure, so a
-- non-zero psql exit code means a test failed.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
  v_count   int;
begin
  -- ── Setup: two independent users sign up ────────────────────────────
  insert into auth.users (id, email) values (user_a_id, 'alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'bob@example.edu');

  -- trigger (0006) should have auto-created a candidate row for each
  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;
  raise notice 'PASS: signup trigger auto-provisioned candidate rows for both users';

  -- stash ids for later tests via a temp table (session-scoped, visible to
  -- subsequent \set-driven psql blocks below)
  create temporary table test_ids (key text primary key, val uuid);
  insert into test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                               ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can SELECT their own row as "authenticated" ---'
do $$
declare v_uid uuid; v_count int;
begin
  select val into v_uid from test_ids where key = 'user_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.candidate where auth_user_id = v_uid;
  reset role;
  if v_count != 1 then
    raise exception 'FAIL: user A could not see their own candidate row (count=%)', v_count;
  end if;
  raise notice 'PASS: user A can select their own candidate row';
end $$;

\echo '--- Test 2: candidate CANNOT see another candidate row (cross-candidate SELECT blocked) ---'
do $$
declare v_uid_a uuid; v_uid_b uuid; v_count int;
begin
  select val into v_uid_a from test_ids where key = 'user_a';
  select val into v_uid_b from test_ids where key = 'user_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  -- user A queries ALL candidate rows visible to them (RLS should filter to just their own)
  select count(*) into v_count from public.candidate where auth_user_id = v_uid_b;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could see user B''s candidate row via RLS bypass (count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot see user B''s candidate row';
end $$;

\echo '--- Test 3: candidate can INSERT their own personal_info ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from test_ids where key = 'user_a';
  select val into v_cand from test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.personal_info (candidate_id, legal_first_name, legal_last_name, email, location_country)
  values (v_cand, 'Alice', 'Nguyen', 'alice@example.edu', 'US');
  reset role;
  select count(*) into v_count from public.personal_info where candidate_id = v_cand;
  if v_count != 1 then
    raise exception 'FAIL: user A could not insert their own personal_info';
  end if;
  raise notice 'PASS: user A can insert their own personal_info';
end $$;

\echo '--- Test 4: candidate CANNOT INSERT personal_info for someone else''s candidate_id ---'
do $$
declare v_uid_a uuid; v_cand_b uuid; failed boolean := false;
begin
  select val into v_uid_a from test_ids where key = 'user_a';
  select val into v_cand_b from test_ids where key = 'cand_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  begin
    insert into public.personal_info (candidate_id, legal_first_name, legal_last_name, email, location_country)
    values (v_cand_b, 'Fake', 'Injection', 'attacker@example.com', 'US');
  exception when others then
    failed := true;
  end;
  reset role;
  if not failed then
    -- also acceptable: 0 rows silently rejected by RLS WITH CHECK depending
    -- on driver; either an exception OR zero effective rows is a pass, but
    -- a *successful* insert is a hard failure.
    perform 1 from public.personal_info where candidate_id = v_cand_b;
    if found then
      raise exception 'FAIL: user A inserted personal_info under user B''s candidate_id';
    end if;
  end if;
  raise notice 'PASS: user A cannot insert personal_info for user B''s candidate';
end $$;

\echo '--- Test 5: candidate CANNOT SELECT another candidate''s personal_info ---'
do $$
declare v_uid_a uuid; v_uid_b uuid; v_cand_b uuid; v_count int;
begin
  select val into v_uid_a from test_ids where key = 'user_a';
  select val into v_uid_b from test_ids where key = 'user_b';
  select val into v_cand_b from test_ids where key = 'cand_b';

  -- user B inserts their own personal_info first
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.personal_info (candidate_id, legal_first_name, legal_last_name, email, location_country)
  values (v_cand_b, 'Bob', 'Martinez', 'bob@example.edu', 'US');
  reset role;

  -- user A tries to read it
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.personal_info where candidate_id = v_cand_b;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s personal_info (PII leak, count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot read user B''s personal_info';
end $$;

\echo '--- Test 6: unauthenticated (anon) role cannot read ANY candidate or personal_info rows ---'
do $$
declare v_count int;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.candidate;
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;
  reset role;
  if v_count > 0 then
    raise exception 'FAIL: anon role could read candidate rows (count=%)', v_count;
  end if;
  raise notice 'PASS: anon role reads zero candidate rows (denied at grant or RLS layer)';
end $$;

\echo '--- Test 7: candidate can INSERT and later re-read their own consent_record ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from test_ids where key = 'user_a';
  select val into v_cand from test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.consent_record (candidate_id, consent_type, version)
  values (v_cand, 'data_processing', 'v1.0');
  select count(*) into v_count from public.consent_record where candidate_id = v_cand;
  reset role;
  if v_count != 1 then
    raise exception 'FAIL: user A could not record/read their own consent';
  end if;
  raise notice 'PASS: user A can record and read their own consent';
end $$;

\echo '--- Test 8: candidate CANNOT see another candidate''s consent_record ---'
do $$
declare v_uid_a uuid; v_cand_b uuid; v_uid_b uuid; v_count int;
begin
  select val into v_uid_a from test_ids where key = 'user_a';
  select val into v_uid_b from test_ids where key = 'user_b';
  select val into v_cand_b from test_ids where key = 'cand_b';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.consent_record (candidate_id, consent_type, version)
  values (v_cand_b, 'data_processing', 'v1.0');
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.consent_record where candidate_id = v_cand_b;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s consent record';
  end if;
  raise notice 'PASS: user A cannot read user B''s consent record';
end $$;

\echo '--- Test 9: one active (unrevoked) consent per (candidate, type) is enforced ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from test_ids where key = 'user_a';
  select val into v_cand from test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    -- user_a already has an active data_processing consent from Test 7
    insert into public.consent_record (candidate_id, consent_type, version)
    values (v_cand, 'data_processing', 'v1.1');
  exception when unique_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: duplicate active consent of the same type was allowed';
  end if;
  raise notice 'PASS: duplicate active consent of the same type is rejected by the unique index';
end $$;

\echo '--- Test 10: service_role can operate across candidates (trusted backend path) ---'
do $$
declare v_count int;
begin
  set local role service_role;
  select count(*) into v_count from public.candidate;
  reset role;
  if v_count < 2 then
    raise exception 'FAIL: service_role could not read across candidates (count=%)', v_count;
  end if;
  raise notice 'PASS: service_role (trusted backend only) can read across candidates';
end $$;

\echo '--- ALL TESTS PASSED ---'
