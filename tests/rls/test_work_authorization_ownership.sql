-- test_work_authorization_ownership.sql
-- Day 2 test suite: WorkAuthorization entity — valid creation, update,
-- enum validation, optional expiry, one-current-record-per-candidate,
-- ownership, cross-candidate access, and unauthenticated access.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- the Day 1 or Education test suites.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (WorkAuthorization suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'wa-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'wa-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table wa_test_ids (key text primary key, val uuid);
  insert into wa_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                  ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid work_authorization record (valid creation) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from wa_test_ids where key = 'user_a';
  select val into v_cand from wa_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.work_authorization
    (candidate_id, citizenship_country, status, requires_sponsorship)
  values
    (v_cand, 'IN', 'f1_opt', true);
  reset role;

  select count(*) into v_count from public.work_authorization where candidate_id = v_cand;
  if v_count != 1 then
    raise exception 'FAIL: valid work_authorization insert did not persist';
  end if;
  raise notice 'PASS: candidate can insert a valid work_authorization record';
end $$;

\echo '--- Test 2: candidate can UPDATE their own work_authorization record ---'
do $$
declare v_uid uuid; v_cand uuid; v_status text; v_expiry date;
begin
  select val into v_uid from wa_test_ids where key = 'user_a';
  select val into v_cand from wa_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  update public.work_authorization
    set status = 'stem_opt_eligible', requires_sponsorship = false, work_auth_expiry_date = '2027-06-30'
    where candidate_id = v_cand;
  select status, work_auth_expiry_date into v_status, v_expiry
    from public.work_authorization where candidate_id = v_cand;
  reset role;

  if v_status != 'stem_opt_eligible' or v_expiry != '2027-06-30' then
    raise exception 'FAIL: update to own work_authorization record did not persist (status=%, expiry=%)', v_status, v_expiry;
  end if;
  raise notice 'PASS: candidate can update their own work_authorization record';
end $$;

\echo '--- Test 3: only ONE work_authorization record per candidate (candidate_id is the primary key) ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from wa_test_ids where key = 'user_a';
  select val into v_cand from wa_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.work_authorization
      (candidate_id, citizenship_country, status, requires_sponsorship)
    values
      (v_cand, 'IN', 'h1b', false);
  exception when unique_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a second work_authorization record was allowed for the same candidate';
  end if;
  raise notice 'PASS: at most one work_authorization record per candidate is enforced (PK on candidate_id)';
end $$;

\echo '--- Test 4: optional work_auth_expiry_date — a record with NULL expiry is valid ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from wa_test_ids where key = 'user_b';
  select val into v_cand from wa_test_ids where key = 'cand_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.work_authorization
    (candidate_id, citizenship_country, status, requires_sponsorship)
  values
    (v_cand, 'US', 'us_citizen', false); -- no work_auth_expiry_date supplied
  select count(*) into v_count from public.work_authorization
    where candidate_id = v_cand and work_auth_expiry_date is null;
  reset role;
  if v_count != 1 then
    raise exception 'FAIL: work_authorization with NULL expiry date did not persist as expected';
  end if;
  raise notice 'PASS: work_auth_expiry_date is optional (NULL is valid)';
end $$;

\echo '--- Test 5: enum validation — an invalid status value is rejected at the DB layer ---'
do $$
declare failed boolean := false;
begin
  set local role service_role; -- exercising the DB constraint directly, ownership not the point here
  begin
    insert into public.work_authorization
      (candidate_id, citizenship_country, status, requires_sponsorship)
    values
      (gen_random_uuid(), 'FR', 'tourist_visa', false);
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an invalid status enum value was accepted by the DB';
  end if;
  raise notice 'PASS: invalid status enum value is rejected by the DB check constraint';
end $$;

\echo '--- Test 6: candidate CANNOT SELECT another candidate''s work_authorization record ---'
do $$
declare v_uid_a uuid; v_cand_b uuid; v_count int;
begin
  select val into v_uid_a from wa_test_ids where key = 'user_a';
  select val into v_cand_b from wa_test_ids where key = 'cand_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.work_authorization where candidate_id = v_cand_b;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s work_authorization record (count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot read user B''s work_authorization record';
end $$;

\echo '--- Test 7: candidate CANNOT UPDATE another candidate''s work_authorization record ---'
do $$
declare v_uid_a uuid; v_cand_b uuid; v_rows_affected int; v_status text;
begin
  select val into v_uid_a from wa_test_ids where key = 'user_a';
  select val into v_cand_b from wa_test_ids where key = 'cand_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  update public.work_authorization set status = 'needs_sponsorship' where candidate_id = v_cand_b;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A updated user B''s work_authorization record (rows_affected=%)', v_rows_affected;
  end if;

  select status into v_status from public.work_authorization where candidate_id = v_cand_b;
  if v_status != 'us_citizen' then
    raise exception 'FAIL: user B''s work_authorization status was changed by user A''s attempt (status=%)', v_status;
  end if;
  raise notice 'PASS: user A cannot update user B''s work_authorization record';
end $$;

\echo '--- Test 8: candidate CANNOT INSERT a work_authorization record under another candidate''s id ---'
do $$
declare v_uid_a uuid; v_cand_b uuid; failed boolean := false;
begin
  select val into v_uid_a from wa_test_ids where key = 'user_a';
  select val into v_cand_b from wa_test_ids where key = 'cand_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  begin
    insert into public.work_authorization
      (candidate_id, citizenship_country, status, requires_sponsorship)
    values
      (v_cand_b, 'IN', 'needs_sponsorship', true);
  exception when others then
    failed := true;
  end;
  reset role;
  if not failed then
    perform 1 from public.work_authorization where candidate_id = v_cand_b and citizenship_country = 'IN';
    if found then
      raise exception 'FAIL: user A inserted a work_authorization row under user B''s candidate_id';
    end if;
  end if;
  raise notice 'PASS: user A cannot insert a work_authorization record for user B''s candidate';
end $$;

\echo '--- Test 9: unauthenticated (anon) role cannot read ANY work_authorization rows ---'
do $$
declare v_count int;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.work_authorization;
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;
  reset role;
  if v_count > 0 then
    raise exception 'FAIL: anon role could read work_authorization rows (count=%)', v_count;
  end if;
  raise notice 'PASS: anon role reads zero work_authorization rows (denied at grant or RLS layer)';
end $$;

\echo '--- Test 10: unauthenticated (anon) role cannot INSERT a work_authorization row ---'
do $$
declare failed boolean := false;
begin
  set local role anon;
  begin
    insert into public.work_authorization
      (candidate_id, citizenship_country, status, requires_sponsorship)
    values
      (gen_random_uuid(), 'US', 'us_citizen', false);
  exception when insufficient_privilege then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: anon role was able to insert a work_authorization row';
  end if;
  raise notice 'PASS: anon role cannot insert a work_authorization row';
end $$;

\echo '--- ALL WORK AUTHORIZATION TESTS PASSED ---'
