-- test_achievement_ownership.sql
-- Day 2 test suite: Achievement entity — valid creation, multiple
-- achievements per candidate, required-field validation, invalid data
-- rejection, own-row read/update/delete, cross-candidate access blocked,
-- and anonymous access blocked.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- the Day 1, Education, WorkAuthorization, Skill, Project, or Experience
-- test suites.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (Achievement suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'ach-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'ach-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table ach_test_ids (key text primary key, val uuid);
  insert into ach_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                   ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid achievement (valid creation) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int; v_id uuid;
begin
  select val into v_uid from ach_test_ids where key = 'user_a';
  select val into v_cand from ach_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.achievement
    (candidate_id, title, issuing_body, date_awarded, rank_or_result, verification_url)
  values
    (v_cand, 'HackMIT Winner', 'HackMIT', '2026-09-20', '1st place', 'https://hackmit.org/results/2026')
  returning id into v_id;
  reset role;

  select count(*) into v_count from public.achievement where id = v_id and candidate_id = v_cand;
  if v_count != 1 then
    raise exception 'FAIL: valid achievement insert did not persist';
  end if;
  raise notice 'PASS: candidate can insert a valid achievement';

  insert into ach_test_ids values ('ach_a_hackmit', v_id);
end $$;

\echo '--- Test 2: candidate supports MULTIPLE achievements (not just one) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from ach_test_ids where key = 'user_a';
  select val into v_cand from ach_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.achievement (candidate_id, title, date_awarded)
  values (v_cand, 'Dean''s List', '2026-01-15');
  select count(*) into v_count from public.achievement where candidate_id = v_cand;
  reset role;
  if v_count < 2 then
    raise exception 'FAIL: candidate could not hold multiple achievements (count=%)', v_count;
  end if;
  raise notice 'PASS: candidate can hold multiple achievements (count=%)', v_count;
end $$;

\echo '--- Test 3: required-field validation — empty title is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from ach_test_ids where key = 'user_a';
  select val into v_cand from ach_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.achievement (candidate_id, title, date_awarded)
    values (v_cand, '   ', '2026-01-15');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an empty/whitespace-only achievement title was accepted by the DB';
  end if;
  raise notice 'PASS: empty/whitespace-only achievement title is rejected by the DB check constraint';
end $$;

\echo '--- Test 4: required-field validation — NULL date_awarded is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from ach_test_ids where key = 'user_a';
  select val into v_cand from ach_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.achievement (candidate_id, title, date_awarded)
    values (v_cand, 'No Date Achievement', null);
  exception when not_null_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a NULL date_awarded was accepted by the DB';
  end if;
  raise notice 'PASS: NULL date_awarded is rejected (NOT NULL constraint)';
end $$;

\echo '--- Test 5: invalid data rejection — nullable fields (issuing_body, rank_or_result, verification_url) may be omitted ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from ach_test_ids where key = 'user_a';
  select val into v_cand from ach_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.achievement (candidate_id, title, date_awarded)
  values (v_cand, 'Minimal Achievement', '2026-03-01');
  select count(*) into v_count from public.achievement
    where candidate_id = v_cand and title = 'Minimal Achievement'
      and issuing_body is null and rank_or_result is null and verification_url is null;
  reset role;
  if v_count != 1 then
    raise exception 'FAIL: an achievement with all optional fields omitted did not persist correctly';
  end if;
  raise notice 'PASS: issuing_body, rank_or_result, and verification_url are all optional';
end $$;

\echo '--- Test 6: candidate can SELECT/UPDATE/DELETE their own achievement (own-row access) ---'
do $$
declare v_uid uuid; v_ach_id uuid; v_rank text; v_count int;
begin
  select val into v_uid from ach_test_ids where key = 'user_a';
  select val into v_ach_id from ach_test_ids where key = 'ach_a_hackmit';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.achievement where id = v_ach_id;
  update public.achievement set rank_or_result = 'Grand Prize' where id = v_ach_id;
  select rank_or_result into v_rank from public.achievement where id = v_ach_id;
  reset role;

  if v_count != 1 or v_rank != 'Grand Prize' then
    raise exception 'FAIL: user A could not select/update their own achievement';
  end if;
  raise notice 'PASS: user A can select and update their own achievement';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  delete from public.achievement where id = v_ach_id;
  reset role;

  select count(*) into v_count from public.achievement where id = v_ach_id;
  if v_count != 0 then
    raise exception 'FAIL: user A could not delete their own achievement';
  end if;
  raise notice 'PASS: user A can delete their own achievement';
end $$;

\echo '--- Test 7: candidate CANNOT SELECT/UPDATE/DELETE another candidate''s achievement (cross-candidate access blocked) ---'
do $$
declare v_uid_b uuid; v_cand_b uuid; v_uid_a uuid; v_ach_b_id uuid; v_count int; v_rows_affected int; v_title text;
begin
  select val into v_uid_b from ach_test_ids where key = 'user_b';
  select val into v_cand_b from ach_test_ids where key = 'cand_b';
  select val into v_uid_a from ach_test_ids where key = 'user_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.achievement (candidate_id, title, date_awarded)
    values (v_cand_b, 'Bob''s Award', '2026-02-01')
    returning id into v_ach_b_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.achievement where id = v_ach_b_id;
  if v_count != 0 then
    reset role;
    raise exception 'FAIL: user A could read user B''s achievement (count=%)', v_count;
  end if;

  update public.achievement set title = 'Hacked' where id = v_ach_b_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected != 0 then
    reset role;
    raise exception 'FAIL: user A updated user B''s achievement (rows_affected=%)', v_rows_affected;
  end if;

  delete from public.achievement where id = v_ach_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s achievement (rows_affected=%)', v_rows_affected;
  end if;

  select title into v_title from public.achievement where id = v_ach_b_id;
  if v_title != 'Bob''s Award' then
    raise exception 'FAIL: user B''s achievement was altered by user A''s attempts (title=%)', v_title;
  end if;
  raise notice 'PASS: user A cannot read, update, or delete user B''s achievement';
end $$;

\echo '--- Test 8: anonymous (anon) role cannot read or insert ANY achievement rows ---'
do $$
declare v_count int; v_insert_failed boolean := false;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.achievement;
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;

  begin
    insert into public.achievement (candidate_id, title, date_awarded)
      values (gen_random_uuid(), 'Anon Achievement', '2026-01-01');
  exception when insufficient_privilege then
    v_insert_failed := true;
  end;
  reset role;

  if v_count > 0 then
    raise exception 'FAIL: anon role could read achievement rows (count=%)', v_count;
  end if;
  if not v_insert_failed then
    raise exception 'FAIL: anon role was able to insert an achievement row';
  end if;
  raise notice 'PASS: anon role cannot read or insert achievement rows';
end $$;

\echo '--- ALL ACHIEVEMENT TESTS PASSED ---'
