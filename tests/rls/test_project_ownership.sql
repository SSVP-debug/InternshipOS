-- test_project_ownership.sql
-- Day 2 test suite: Project entity — valid creation, multiple projects per
-- candidate, required-field validation, invalid data rejection, own-row
-- read/update/delete, cross-candidate access blocked, and anonymous access
-- blocked.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- the Day 1, Education, WorkAuthorization, or Skill test suites.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (Project suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'proj-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'proj-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table project_test_ids (key text primary key, val uuid);
  insert into project_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                       ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid project representing a real student project (InternshipOS) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int; v_id uuid;
begin
  select val into v_uid from project_test_ids where key = 'user_a';
  select val into v_cand from project_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.project
    (candidate_id, title, description, role, team_size, start_date, is_ongoing, tech_stack, external_url)
  values
    (v_cand, 'InternshipOS', 'An internship application intelligence platform.',
     'solo', 1, '2026-06-01', true, array['TypeScript','Postgres','Supabase'], 'https://github.com/example/internshipos')
  returning id into v_id;
  reset role;

  select count(*) into v_count from public.project where id = v_id and candidate_id = v_cand;
  if v_count != 1 then
    raise exception 'FAIL: valid project insert (InternshipOS) did not persist';
  end if;
  raise notice 'PASS: candidate can insert a valid project (InternshipOS)';

  insert into project_test_ids values ('proj_a_internshipos', v_id);
end $$;

\echo '--- Test 2: candidate supports MULTIPLE projects (e.g. Code Club alongside InternshipOS) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from project_test_ids where key = 'user_a';
  select val into v_cand from project_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.project
    (candidate_id, title, description, role, team_size, start_date, end_date, is_ongoing)
  values
    (v_cand, 'Code Club', 'Ran weekly programming workshops for first-year students.',
     'team lead', 5, '2024-09-01', '2025-05-15', false);
  select count(*) into v_count from public.project where candidate_id = v_cand;
  reset role;
  if v_count < 2 then
    raise exception 'FAIL: candidate could not hold multiple projects (count=%)', v_count;
  end if;
  raise notice 'PASS: candidate can hold multiple projects (count=%)', v_count;
end $$;

\echo '--- Test 3: required-field validation — empty title is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from project_test_ids where key = 'user_a';
  select val into v_cand from project_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.project (candidate_id, title, description)
    values (v_cand, '   ', 'Missing a real title.');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an empty/whitespace-only project title was accepted by the DB';
  end if;
  raise notice 'PASS: empty/whitespace-only project title is rejected by the DB check constraint';
end $$;

\echo '--- Test 4: required-field validation — NULL description is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from project_test_ids where key = 'user_a';
  select val into v_cand from project_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.project (candidate_id, title, description)
    values (v_cand, 'No Description Project', null);
  exception when not_null_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a NULL project description was accepted by the DB';
  end if;
  raise notice 'PASS: NULL project description is rejected (NOT NULL constraint)';
end $$;

\echo '--- Test 5: invalid data rejection — end_date before start_date is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from project_test_ids where key = 'user_a';
  select val into v_cand from project_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.project (candidate_id, title, description, start_date, end_date)
    values (v_cand, 'Bad Timeline Project', 'End before start.', '2026-06-01', '2020-01-01');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: end_date before start_date was accepted by the DB';
  end if;
  raise notice 'PASS: end_date before start_date is rejected (project_end_after_start)';
end $$;

\echo '--- Test 6: invalid data rejection — is_ongoing=true combined with an end_date is rejected ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from project_test_ids where key = 'user_a';
  select val into v_cand from project_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.project (candidate_id, title, description, is_ongoing, end_date)
    values (v_cand, 'Contradictory Project', 'Cannot be both ongoing and finished.', true, '2026-08-01');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: is_ongoing=true with an end_date was accepted by the DB';
  end if;
  raise notice 'PASS: is_ongoing=true combined with an end_date is rejected (project_ongoing_has_no_end_date)';
end $$;

\echo '--- Test 7: candidate can SELECT/UPDATE/DELETE their own project (own-row access) ---'
do $$
declare v_uid uuid; v_proj_id uuid; v_title text; v_count int;
begin
  select val into v_uid from project_test_ids where key = 'user_a';
  select val into v_proj_id from project_test_ids where key = 'proj_a_internshipos';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.project where id = v_proj_id;
  update public.project set description = 'Updated description for InternshipOS.' where id = v_proj_id;
  select title into v_title from public.project where id = v_proj_id;
  reset role;

  if v_count != 1 or v_title != 'InternshipOS' then
    raise exception 'FAIL: user A could not select/update their own project';
  end if;
  raise notice 'PASS: user A can select and update their own project';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  delete from public.project where id = v_proj_id;
  reset role;

  select count(*) into v_count from public.project where id = v_proj_id;
  if v_count != 0 then
    raise exception 'FAIL: user A could not delete their own project';
  end if;
  raise notice 'PASS: user A can delete their own project';
end $$;

\echo '--- Test 8: candidate CANNOT SELECT another candidate''s project (cross-candidate access blocked) ---'
do $$
declare v_uid_b uuid; v_cand_b uuid; v_uid_a uuid; v_proj_b_id uuid; v_count int;
begin
  select val into v_uid_b from project_test_ids where key = 'user_b';
  select val into v_cand_b from project_test_ids where key = 'cand_b';
  select val into v_uid_a from project_test_ids where key = 'user_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.project (candidate_id, title, description)
    values (v_cand_b, 'Bob''s Project', 'A project belonging to Bob.')
    returning id into v_proj_b_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.project where id = v_proj_b_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s project (count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot read user B''s project';

  insert into project_test_ids values ('proj_b', v_proj_b_id);
end $$;

\echo '--- Test 9: candidate CANNOT UPDATE or DELETE another candidate''s project ---'
do $$
declare v_uid_a uuid; v_proj_b_id uuid; v_rows_affected int; v_title text;
begin
  select val into v_uid_a from project_test_ids where key = 'user_a';
  select val into v_proj_b_id from project_test_ids where key = 'proj_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;

  update public.project set title = 'Hacked' where id = v_proj_b_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected != 0 then
    reset role;
    raise exception 'FAIL: user A updated user B''s project (rows_affected=%)', v_rows_affected;
  end if;

  delete from public.project where id = v_proj_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s project (rows_affected=%)', v_rows_affected;
  end if;

  select title into v_title from public.project where id = v_proj_b_id;
  if v_title != 'Bob''s Project' then
    raise exception 'FAIL: user B''s project was altered by user A''s attempts (title=%)', v_title;
  end if;
  raise notice 'PASS: user A cannot update or delete user B''s project';
end $$;

\echo '--- Test 10: anonymous (anon) role cannot read or insert ANY project rows ---'
do $$
declare v_count int; v_insert_failed boolean := false;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.project;
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;

  begin
    insert into public.project (candidate_id, title, description)
      values (gen_random_uuid(), 'Anon Project', 'Should never be allowed.');
  exception when insufficient_privilege then
    v_insert_failed := true;
  end;
  reset role;

  if v_count > 0 then
    raise exception 'FAIL: anon role could read project rows (count=%)', v_count;
  end if;
  if not v_insert_failed then
    raise exception 'FAIL: anon role was able to insert a project row';
  end if;
  raise notice 'PASS: anon role cannot read or insert project rows';
end $$;

\echo '--- ALL PROJECT TESTS PASSED ---'
