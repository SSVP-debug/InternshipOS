-- test_skill_ownership.sql
-- Day 2 test suite: Skill entity — valid creation, multiple skills per
-- candidate, validation failures, duplicate handling, own-row
-- read/update/delete, cross-candidate access, and anonymous access.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- the Day 1, Education, or WorkAuthorization test suites.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (Skill suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'skill-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'skill-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table skill_test_ids (key text primary key, val uuid);
  insert into skill_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                     ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid skill (valid creation) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int; v_id uuid;
begin
  select val into v_uid from skill_test_ids where key = 'user_a';
  select val into v_cand from skill_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.skill (candidate_id, name, category, self_rating)
  values (v_cand, 'Python', 'language', 'advanced')
  returning id into v_id;
  reset role;

  select count(*) into v_count from public.skill where id = v_id and candidate_id = v_cand;
  if v_count != 1 then
    raise exception 'FAIL: valid skill insert did not persist';
  end if;
  -- evidence_backed should default to false — not writable in Phase 0
  perform 1 from public.skill where id = v_id and evidence_backed = false;
  if not found then
    raise exception 'FAIL: evidence_backed did not default to false';
  end if;
  raise notice 'PASS: candidate can insert a valid skill, evidence_backed defaults to false';

  insert into skill_test_ids values ('skill_a_python', v_id);
end $$;

\echo '--- Test 2: candidate supports MULTIPLE skills (not just one) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from skill_test_ids where key = 'user_a';
  select val into v_cand from skill_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.skill (candidate_id, name, category) values (v_cand, 'React', 'framework');
  insert into public.skill (candidate_id, name, category) values (v_cand, 'Docker', 'tool');
  select count(*) into v_count from public.skill where candidate_id = v_cand;
  reset role;
  if v_count < 3 then
    raise exception 'FAIL: candidate could not hold multiple skills (count=%)', v_count;
  end if;
  raise notice 'PASS: candidate can hold multiple skills (count=%)', v_count;
end $$;

\echo '--- Test 3: validation failure — empty name is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from skill_test_ids where key = 'user_a';
  select val into v_cand from skill_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.skill (candidate_id, name, category) values (v_cand, '   ', 'tool');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an empty/whitespace-only skill name was accepted by the DB';
  end if;
  raise notice 'PASS: empty/whitespace-only skill name is rejected by the DB check constraint';
end $$;

\echo '--- Test 4: validation failure — invalid category enum is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from skill_test_ids where key = 'user_a';
  select val into v_cand from skill_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.skill (candidate_id, name, category) values (v_cand, 'Golfing', 'hobby');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an invalid category enum value was accepted by the DB';
  end if;
  raise notice 'PASS: invalid category enum value is rejected by the DB check constraint';
end $$;

\echo '--- Test 5: duplicate handling — same normalized name for the same candidate is rejected ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from skill_test_ids where key = 'user_a';
  select val into v_cand from skill_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    -- differs only in case + whitespace from the "Python" inserted in Test 1
    insert into public.skill (candidate_id, name, category) values (v_cand, '  python  ', 'tool');
  exception when unique_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a case/whitespace-variant duplicate skill was accepted';
  end if;
  raise notice 'PASS: duplicate skill (normalized name match) is rejected regardless of case/whitespace';
end $$;

\echo '--- Test 6: candidate can SELECT/UPDATE/DELETE their own skill (own-row access) ---'
do $$
declare v_uid uuid; v_skill_id uuid; v_rating text; v_count int;
begin
  select val into v_uid from skill_test_ids where key = 'user_a';
  select val into v_skill_id from skill_test_ids where key = 'skill_a_python';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.skill where id = v_skill_id;
  update public.skill set self_rating = 'proficient' where id = v_skill_id;
  select self_rating into v_rating from public.skill where id = v_skill_id;
  reset role;

  if v_count != 1 or v_rating != 'proficient' then
    raise exception 'FAIL: user A could not select/update their own skill';
  end if;
  raise notice 'PASS: user A can select and update their own skill';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  delete from public.skill where id = v_skill_id;
  reset role;

  select count(*) into v_count from public.skill where id = v_skill_id;
  if v_count != 0 then
    raise exception 'FAIL: user A could not delete their own skill';
  end if;
  raise notice 'PASS: user A can delete their own skill';
end $$;

\echo '--- Test 7: candidate CANNOT SELECT another candidate''s skill (cross-candidate access blocked) ---'
do $$
declare v_uid_b uuid; v_cand_b uuid; v_uid_a uuid; v_skill_b_id uuid; v_count int;
begin
  select val into v_uid_b from skill_test_ids where key = 'user_b';
  select val into v_cand_b from skill_test_ids where key = 'cand_b';
  select val into v_uid_a from skill_test_ids where key = 'user_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.skill (candidate_id, name, category) values (v_cand_b, 'Go', 'language')
    returning id into v_skill_b_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.skill where id = v_skill_b_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s skill (count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot read user B''s skill';

  insert into skill_test_ids values ('skill_b_go', v_skill_b_id);
end $$;

\echo '--- Test 8: candidate CANNOT UPDATE or DELETE another candidate''s skill ---'
do $$
declare v_uid_a uuid; v_skill_b_id uuid; v_rows_affected int; v_name text;
begin
  select val into v_uid_a from skill_test_ids where key = 'user_a';
  select val into v_skill_b_id from skill_test_ids where key = 'skill_b_go';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;

  update public.skill set name = 'Hacked' where id = v_skill_b_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected != 0 then
    reset role;
    raise exception 'FAIL: user A updated user B''s skill (rows_affected=%)', v_rows_affected;
  end if;

  delete from public.skill where id = v_skill_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s skill (rows_affected=%)', v_rows_affected;
  end if;

  select name into v_name from public.skill where id = v_skill_b_id;
  if v_name != 'Go' then
    raise exception 'FAIL: user B''s skill was altered by user A''s attempts (name=%)', v_name;
  end if;
  raise notice 'PASS: user A cannot update or delete user B''s skill';
end $$;

\echo '--- Test 9: anonymous (anon) role cannot read ANY skill rows ---'
do $$
declare v_count int;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.skill;
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;
  reset role;
  if v_count > 0 then
    raise exception 'FAIL: anon role could read skill rows (count=%)', v_count;
  end if;
  raise notice 'PASS: anon role reads zero skill rows (denied at grant or RLS layer)';
end $$;

\echo '--- Test 10: anonymous (anon) role cannot INSERT a skill row ---'
do $$
declare failed boolean := false;
begin
  set local role anon;
  begin
    insert into public.skill (candidate_id, name, category) values (gen_random_uuid(), 'Rust', 'language');
  exception when insufficient_privilege then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: anon role was able to insert a skill row';
  end if;
  raise notice 'PASS: anon role cannot insert a skill row';
end $$;

\echo '--- ALL SKILL TESTS PASSED ---'
