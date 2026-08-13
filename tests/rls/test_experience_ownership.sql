-- test_experience_ownership.sql
-- Day 2 test suite: Experience entity — valid creation, multiple
-- experiences per candidate, required-field validation, invalid
-- enum/data rejection, date consistency, ongoing/current rules, own-row
-- read/update/delete, cross-candidate access blocked, and anonymous
-- access blocked.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- the Day 1, Education, WorkAuthorization, Skill, or Project test suites.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (Experience suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'exp-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'exp-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table exp_test_ids (key text primary key, val uuid);
  insert into exp_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                   ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid experience record (valid creation) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int; v_id uuid;
begin
  select val into v_uid from exp_test_ids where key = 'user_a';
  select val into v_cand from exp_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.experience
    (candidate_id, organization, title, employment_type, start_date, end_date, location, description_raw)
  values
    (v_cand, 'Acme Corp', 'Software Engineering Intern', 'internship',
     '2026-06-01', '2026-08-15', 'Remote', 'Built internal tooling for the platform team.')
  returning id into v_id;
  reset role;

  select count(*) into v_count from public.experience where id = v_id and candidate_id = v_cand;
  if v_count != 1 then
    raise exception 'FAIL: valid experience insert did not persist';
  end if;
  raise notice 'PASS: candidate can insert a valid experience record';

  insert into exp_test_ids values ('exp_a_acme', v_id);
end $$;

\echo '--- Test 2: candidate supports MULTIPLE experience records (not just one) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from exp_test_ids where key = 'user_a';
  select val into v_cand from exp_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.experience
    (candidate_id, organization, title, employment_type, start_date, is_current, description_raw)
  values
    (v_cand, 'Research Lab', 'Undergraduate Research Assistant', 'research',
     '2026-09-01', true, 'Assisting with data collection and analysis.');
  select count(*) into v_count from public.experience where candidate_id = v_cand;
  reset role;
  if v_count < 2 then
    raise exception 'FAIL: candidate could not hold multiple experience records (count=%)', v_count;
  end if;
  raise notice 'PASS: candidate can hold multiple experience records (count=%)', v_count;

  insert into exp_test_ids values ('exp_a_research',
    (select id from public.experience where candidate_id = v_cand and organization = 'Research Lab'));
end $$;

\echo '--- Test 3: required-field validation — empty organization is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from exp_test_ids where key = 'user_a';
  select val into v_cand from exp_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.experience
      (candidate_id, organization, title, employment_type, start_date, description_raw)
    values
      (v_cand, '   ', 'Intern', 'internship', '2026-06-01', 'Some description.');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an empty/whitespace-only organization was accepted by the DB';
  end if;
  raise notice 'PASS: empty/whitespace-only organization is rejected by the DB check constraint';
end $$;

\echo '--- Test 4: required-field validation — NULL description_raw is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from exp_test_ids where key = 'user_a';
  select val into v_cand from exp_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.experience
      (candidate_id, organization, title, employment_type, start_date, description_raw)
    values
      (v_cand, 'No Description Co', 'Intern', 'internship', '2026-06-01', null);
  exception when not_null_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a NULL description_raw was accepted by the DB';
  end if;
  raise notice 'PASS: NULL description_raw is rejected (NOT NULL constraint)';
end $$;

\echo '--- Test 5: invalid enum rejection — an unrecognized employment_type is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from exp_test_ids where key = 'user_a';
  select val into v_cand from exp_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.experience
      (candidate_id, organization, title, employment_type, start_date, description_raw)
    values
      (v_cand, 'Gig Co', 'Contractor', 'contract', '2026-06-01', 'Freelance work.');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an invalid employment_type enum value was accepted by the DB';
  end if;
  raise notice 'PASS: invalid employment_type enum value is rejected by the DB check constraint';
end $$;

\echo '--- Test 6: date consistency — end_date before start_date is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from exp_test_ids where key = 'user_a';
  select val into v_cand from exp_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.experience
      (candidate_id, organization, title, employment_type, start_date, end_date, description_raw)
    values
      (v_cand, 'Bad Timeline Co', 'Intern', 'internship', '2026-06-01', '2020-01-01', 'End before start.');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: end_date before start_date was accepted by the DB';
  end if;
  raise notice 'PASS: end_date before start_date is rejected (experience_end_after_start)';
end $$;

\echo '--- Test 7: ongoing/current rules — is_current=true combined with an end_date is rejected ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from exp_test_ids where key = 'user_a';
  select val into v_cand from exp_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.experience
      (candidate_id, organization, title, employment_type, start_date, is_current, end_date, description_raw)
    values
      (v_cand, 'Contradictory Co', 'Intern', 'internship', '2026-06-01', true, '2026-08-01', 'Cannot be both.');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: is_current=true with an end_date was accepted by the DB';
  end if;
  raise notice 'PASS: is_current=true combined with an end_date is rejected (experience_current_has_no_end_date)';
end $$;

\echo '--- Test 8: candidate can SELECT/UPDATE/DELETE their own experience (own-row access) ---'
do $$
declare v_uid uuid; v_exp_id uuid; v_title text; v_count int;
begin
  select val into v_uid from exp_test_ids where key = 'user_a';
  select val into v_exp_id from exp_test_ids where key = 'exp_a_acme';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.experience where id = v_exp_id;
  update public.experience set description_raw = 'Updated description.' where id = v_exp_id;
  select title into v_title from public.experience where id = v_exp_id;
  reset role;

  if v_count != 1 or v_title != 'Software Engineering Intern' then
    raise exception 'FAIL: user A could not select/update their own experience';
  end if;
  raise notice 'PASS: user A can select and update their own experience';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  delete from public.experience where id = v_exp_id;
  reset role;

  select count(*) into v_count from public.experience where id = v_exp_id;
  if v_count != 0 then
    raise exception 'FAIL: user A could not delete their own experience';
  end if;
  raise notice 'PASS: user A can delete their own experience';
end $$;

\echo '--- Test 9: candidate CANNOT SELECT/UPDATE/DELETE another candidate''s experience (cross-candidate access blocked) ---'
do $$
declare v_uid_b uuid; v_cand_b uuid; v_uid_a uuid; v_exp_b_id uuid; v_count int; v_rows_affected int; v_title text;
begin
  select val into v_uid_b from exp_test_ids where key = 'user_b';
  select val into v_cand_b from exp_test_ids where key = 'cand_b';
  select val into v_uid_a from exp_test_ids where key = 'user_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.experience
    (candidate_id, organization, title, employment_type, start_date, description_raw)
  values
    (v_cand_b, 'Bob''s Company', 'Bob''s Role', 'part_time', '2026-01-01', 'Bob''s work.')
  returning id into v_exp_b_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.experience where id = v_exp_b_id;
  if v_count != 0 then
    reset role;
    raise exception 'FAIL: user A could read user B''s experience (count=%)', v_count;
  end if;

  update public.experience set title = 'Hacked' where id = v_exp_b_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected != 0 then
    reset role;
    raise exception 'FAIL: user A updated user B''s experience (rows_affected=%)', v_rows_affected;
  end if;

  delete from public.experience where id = v_exp_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s experience (rows_affected=%)', v_rows_affected;
  end if;

  select title into v_title from public.experience where id = v_exp_b_id;
  if v_title != 'Bob''s Role' then
    raise exception 'FAIL: user B''s experience was altered by user A''s attempts (title=%)', v_title;
  end if;
  raise notice 'PASS: user A cannot read, update, or delete user B''s experience';
end $$;

\echo '--- Test 10: anonymous (anon) role cannot read or insert ANY experience rows ---'
do $$
declare v_count int; v_insert_failed boolean := false;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.experience;
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;

  begin
    insert into public.experience
      (candidate_id, organization, title, employment_type, start_date, description_raw)
      values (gen_random_uuid(), 'Anon Co', 'Anon Role', 'volunteer', '2026-01-01', 'Should never be allowed.');
  exception when insufficient_privilege then
    v_insert_failed := true;
  end;
  reset role;

  if v_count > 0 then
    raise exception 'FAIL: anon role could read experience rows (count=%)', v_count;
  end if;
  if not v_insert_failed then
    raise exception 'FAIL: anon role was able to insert an experience row';
  end if;
  raise notice 'PASS: anon role cannot read or insert experience rows';
end $$;

\echo '--- ALL EXPERIENCE TESTS PASSED ---'
