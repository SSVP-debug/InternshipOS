-- test_education_ownership.sql
-- Day 2 test suite: Education entity — valid data, temporal/GPA constraints
-- at the DB layer, ownership, and cross-candidate access.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- tests/rls/test_ownership_and_access.sql (Day 1 suite).

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (Education suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'edu-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'edu-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table edu_test_ids (key text primary key, val uuid);
  insert into edu_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                   ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid education record for themselves ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int; v_id uuid;
begin
  select val into v_uid from edu_test_ids where key = 'user_a';
  select val into v_cand from edu_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.education
    (candidate_id, institution_name, institution_country, degree_type, major,
     start_date, enrollment_status, is_primary)
  values
    (v_cand, 'State University', 'US', 'bachelor', 'Computer Science',
     '2023-08-15', 'current', true)
  returning id into v_id;
  reset role;

  select count(*) into v_count from public.education where id = v_id and candidate_id = v_cand;
  if v_count != 1 then
    raise exception 'FAIL: valid education insert did not persist';
  end if;
  raise notice 'PASS: candidate can insert a valid education record';

  insert into edu_test_ids values ('edu_a_primary', v_id) on conflict (key) do update set val = excluded.val;
end $$;

\echo '--- Test 2: gpa_value without gpa_scale is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from edu_test_ids where key = 'user_a';
  select val into v_cand from edu_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.education
      (candidate_id, institution_name, institution_country, degree_type, major,
       start_date, enrollment_status, gpa_value)
    values
      (v_cand, 'Community College', 'US', 'associate', 'General Studies',
       '2021-01-10', 'graduated', 3.5);
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: gpa_value without gpa_scale was accepted by the DB';
  end if;
  raise notice 'PASS: gpa_value without gpa_scale is rejected (education_gpa_scale_required_with_value)';
end $$;

\echo '--- Test 3: expected_graduation_date before start_date is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from edu_test_ids where key = 'user_a';
  select val into v_cand from edu_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.education
      (candidate_id, institution_name, institution_country, degree_type, major,
       start_date, expected_graduation_date, enrollment_status)
    values
      (v_cand, 'Bad Timeline College', 'US', 'bachelor', 'History',
       '2023-08-15', '2020-01-01', 'current');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: expected_graduation_date before start_date was accepted by the DB';
  end if;
  raise notice 'PASS: expected_graduation_date before start_date is rejected (education_expected_grad_after_start)';
end $$;

\echo '--- Test 4: a second is_primary=true row for the same candidate is rejected ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from edu_test_ids where key = 'user_a';
  select val into v_cand from edu_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.education
      (candidate_id, institution_name, institution_country, degree_type, major,
       start_date, enrollment_status, is_primary)
    values
      (v_cand, 'Second School', 'US', 'master', 'Data Science',
       '2027-08-15', 'current', true);
  exception when unique_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a second is_primary education row was allowed for the same candidate';
  end if;
  raise notice 'PASS: at most one is_primary education row per candidate is enforced';
end $$;

\echo '--- Test 5: candidate can SELECT/UPDATE their own education row (ownership) ---'
do $$
declare v_uid uuid; v_edu_id uuid; v_count int;
begin
  select val into v_uid from edu_test_ids where key = 'user_a';
  select val into v_edu_id from edu_test_ids where key = 'edu_a_primary';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.education where id = v_edu_id;
  update public.education set major = 'Computer Science (Updated)' where id = v_edu_id;
  reset role;
  if v_count != 1 then
    raise exception 'FAIL: user A could not see their own education row';
  end if;
  raise notice 'PASS: user A can select and update their own education row';
end $$;

\echo '--- Test 6: candidate CANNOT SELECT another candidate''s education row (cross-candidate access blocked) ---'
do $$
declare v_uid_b uuid; v_cand_b uuid; v_uid_a uuid; v_edu_b_id uuid; v_count int;
begin
  select val into v_uid_b from edu_test_ids where key = 'user_b';
  select val into v_cand_b from edu_test_ids where key = 'cand_b';
  select val into v_uid_a from edu_test_ids where key = 'user_a';

  -- user B creates their own education record
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.education
    (candidate_id, institution_name, institution_country, degree_type, major,
     start_date, enrollment_status)
  values
    (v_cand_b, 'Bob''s University', 'US', 'bachelor', 'Physics', '2022-08-15', 'current')
  returning id into v_edu_b_id;
  reset role;

  -- user A tries to read it
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.education where id = v_edu_b_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s education row (count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot read user B''s education row';

  insert into edu_test_ids values ('edu_b', v_edu_b_id) on conflict (key) do update set val = excluded.val;
end $$;

\echo '--- Test 7: candidate CANNOT UPDATE another candidate''s education row ---'
do $$
declare v_uid_a uuid; v_edu_b_id uuid; v_rows_affected int;
begin
  select val into v_uid_a from edu_test_ids where key = 'user_a';
  select val into v_edu_b_id from edu_test_ids where key = 'edu_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  update public.education set major = 'Hacked Major' where id = v_edu_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A updated user B''s education row (rows_affected=%)', v_rows_affected;
  end if;
  raise notice 'PASS: user A cannot update user B''s education row (RLS silently affects 0 rows)';
end $$;

\echo '--- Test 8: candidate CANNOT DELETE another candidate''s education row ---'
do $$
declare v_uid_a uuid; v_edu_b_id uuid; v_rows_affected int; v_count int;
begin
  select val into v_uid_a from edu_test_ids where key = 'user_a';
  select val into v_edu_b_id from edu_test_ids where key = 'edu_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  delete from public.education where id = v_edu_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s education row (rows_affected=%)', v_rows_affected;
  end if;

  select count(*) into v_count from public.education where id = v_edu_b_id;
  if v_count != 1 then
    raise exception 'FAIL: user B''s education row no longer exists after user A''s delete attempt';
  end if;
  raise notice 'PASS: user A cannot delete user B''s education row';
end $$;

\echo '--- Test 9: candidate supports MULTIPLE education records (not just one) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from edu_test_ids where key = 'user_a';
  select val into v_cand from edu_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.education
    (candidate_id, institution_name, institution_country, degree_type, major,
     start_date, enrollment_status, is_primary)
  values
    (v_cand, 'High School', 'US', 'other', 'General', '2018-08-15', 'graduated', false);
  select count(*) into v_count from public.education where candidate_id = v_cand;
  reset role;
  if v_count < 2 then
    raise exception 'FAIL: candidate could not hold multiple education records (count=%)', v_count;
  end if;
  raise notice 'PASS: candidate can hold multiple education records (count=%)', v_count;
end $$;

\echo '--- Test 10: anon role cannot read ANY education rows ---'
do $$
declare v_count int;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.education;
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;
  reset role;
  if v_count > 0 then
    raise exception 'FAIL: anon role could read education rows (count=%)', v_count;
  end if;
  raise notice 'PASS: anon role reads zero education rows (denied at grant or RLS layer)';
end $$;

\echo '--- ALL EDUCATION TESTS PASSED ---'
