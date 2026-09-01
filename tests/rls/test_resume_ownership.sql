-- test_resume_ownership.sql
-- Gate R1 test suite: resume + resume_skill — valid creation, validation
-- failures, own-row read/update/delete, cross-candidate access (both
-- tables, including the "attach another candidate's skill via my own
-- resume" attack the resume_skill insert policy specifically guards
-- against), and anonymous access.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users + skills), does not depend on
-- or modify any other test suite.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning + skills (Resume suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
  skill_a_py_id uuid;
  skill_a_js_id uuid;
  skill_b_go_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'resume-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'resume-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', user_a_id)::text, true);
  set local role authenticated;
  insert into public.skill (candidate_id, name, category) values (cand_a_id, 'Python', 'language')
    returning id into skill_a_py_id;
  insert into public.skill (candidate_id, name, category) values (cand_a_id, 'JavaScript', 'language')
    returning id into skill_a_js_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', user_b_id)::text, true);
  set local role authenticated;
  insert into public.skill (candidate_id, name, category) values (cand_b_id, 'Go', 'language')
    returning id into skill_b_go_id;
  reset role;

  create temporary table resume_test_ids (key text primary key, val uuid);
  insert into resume_test_ids values
    ('user_a', user_a_id), ('user_b', user_b_id),
    ('cand_a', cand_a_id), ('cand_b', cand_b_id),
    ('skill_a_py', skill_a_py_id), ('skill_a_js', skill_a_js_id),
    ('skill_b_go', skill_b_go_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid resume (label only, no file) ---'
do $$
declare v_uid uuid; v_cand uuid; v_id uuid; v_count int;
begin
  select val into v_uid from resume_test_ids where key = 'user_a';
  select val into v_cand from resume_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.resume (candidate_id, label, target_role_category)
  values (v_cand, 'Software Development', 'Software Engineering')
  returning id into v_id;
  reset role;

  select count(*) into v_count from public.resume
    where id = v_id and candidate_id = v_cand and is_active = true;
  if v_count != 1 then
    raise exception 'FAIL: valid resume did not persist (is_active should default true)';
  end if;
  raise notice 'PASS: candidate can insert a valid resume, is_active defaults to true';

  insert into resume_test_ids values ('resume_a_swe', v_id);
end $$;

\echo '--- Test 2: candidate supports MULTIPLE resumes (not just one) ---'
do $$
declare v_uid uuid; v_cand uuid; v_id uuid; v_count int;
begin
  select val into v_uid from resume_test_ids where key = 'user_a';
  select val into v_cand from resume_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.resume (candidate_id, label) values (v_cand, 'AI/ML')
    returning id into v_id;
  select count(*) into v_count from public.resume where candidate_id = v_cand;
  reset role;

  if v_count != 2 then
    raise exception 'FAIL: expected 2 resumes for candidate A, got %', v_count;
  end if;
  raise notice 'PASS: candidate can hold multiple resumes with no cap';

  insert into resume_test_ids values ('resume_a_ml', v_id);
end $$;

\echo '--- Test 3: validation failure — empty/whitespace-only label is rejected ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from resume_test_ids where key = 'user_a';
  select val into v_cand from resume_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.resume (candidate_id, label) values (v_cand, '   ');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an empty/whitespace-only resume label was accepted by the DB';
  end if;
  raise notice 'PASS: empty/whitespace-only resume label is rejected by the DB check constraint';
end $$;

\echo '--- Test 4: candidate can attach an existing skill to their own resume via resume_skill ---'
do $$
declare v_uid uuid; v_resume uuid; v_skill uuid; v_id uuid; v_count int;
begin
  select val into v_uid from resume_test_ids where key = 'user_a';
  select val into v_resume from resume_test_ids where key = 'resume_a_swe';
  select val into v_skill from resume_test_ids where key = 'skill_a_py';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.resume_skill (resume_id, skill_id) values (v_resume, v_skill)
    returning id into v_id;
  select count(*) into v_count from public.resume_skill where id = v_id;
  reset role;

  if v_count != 1 then
    raise exception 'FAIL: candidate could not attach their own skill to their own resume';
  end if;
  raise notice 'PASS: candidate can attach their own skill to their own resume';
end $$;

\echo '--- Test 5: same skill CAN be attached to a second resume (many-to-many, not exclusive) ---'
do $$
declare v_uid uuid; v_resume uuid; v_skill uuid; v_count int;
begin
  select val into v_uid from resume_test_ids where key = 'user_a';
  select val into v_resume from resume_test_ids where key = 'resume_a_ml';
  select val into v_skill from resume_test_ids where key = 'skill_a_py';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.resume_skill (resume_id, skill_id) values (v_resume, v_skill);
  select count(*) into v_count from public.resume_skill where skill_id = v_skill;
  reset role;

  if v_count != 2 then
    raise exception 'FAIL: expected skill to be linked to 2 resumes, got %', v_count;
  end if;
  raise notice 'PASS: one skill can belong to multiple resumes (no duplicated skill data)';
end $$;

\echo '--- Test 6: duplicate handling — same skill cannot be attached twice to the same resume ---'
do $$
declare v_uid uuid; v_resume uuid; v_skill uuid; failed boolean := false;
begin
  select val into v_uid from resume_test_ids where key = 'user_a';
  select val into v_resume from resume_test_ids where key = 'resume_a_swe';
  select val into v_skill from resume_test_ids where key = 'skill_a_py';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.resume_skill (resume_id, skill_id) values (v_resume, v_skill);
  exception when unique_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a duplicate (resume_id, skill_id) pair was accepted';
  end if;
  raise notice 'PASS: duplicate resume_skill pair is rejected by the unique constraint';
end $$;

\echo '--- Test 7: candidate CANNOT attach ANOTHER candidate''s skill to their own resume (cross-candidate skill-linking attack) ---'
do $$
declare v_uid_a uuid; v_resume_a uuid; v_skill_b uuid; failed boolean := false; v_count int;
begin
  select val into v_uid_a from resume_test_ids where key = 'user_a';
  select val into v_resume_a from resume_test_ids where key = 'resume_a_swe';
  select val into v_skill_b from resume_test_ids where key = 'skill_b_go';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  begin
    insert into public.resume_skill (resume_id, skill_id) values (v_resume_a, v_skill_b);
  exception when insufficient_privilege or others then
    failed := true;
  end;
  reset role;

  select count(*) into v_count from public.resume_skill rs
    where rs.resume_id = v_resume_a and rs.skill_id = v_skill_b;
  if not failed or v_count != 0 then
    raise exception 'FAIL: user A was able to attach user B''s skill to user A''s own resume';
  end if;
  raise notice 'PASS: candidate cannot attach another candidate''s skill to their own resume, even though they own the resume side of the link';
end $$;

\echo '--- Test 8: candidate can SELECT/UPDATE/DELETE their own resume (own-row access) ---'
do $$
declare v_uid uuid; v_resume uuid; v_active boolean; v_count int;
begin
  select val into v_uid from resume_test_ids where key = 'user_a';
  select val into v_resume from resume_test_ids where key = 'resume_a_ml';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.resume where id = v_resume;
  update public.resume set is_active = false where id = v_resume;
  select is_active into v_active from public.resume where id = v_resume;
  reset role;

  if v_count != 1 or v_active != false then
    raise exception 'FAIL: user A could not select/archive their own resume';
  end if;
  raise notice 'PASS: user A can select and archive (is_active=false) their own resume';
end $$;

\echo '--- Test 9: archiving a resume does NOT delete its resume_skill links ---'
do $$
declare v_uid uuid; v_resume uuid; v_count int;
begin
  select val into v_uid from resume_test_ids where key = 'user_a';
  select val into v_resume from resume_test_ids where key = 'resume_a_ml';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.resume_skill where resume_id = v_resume;
  reset role;

  if v_count != 1 then
    raise exception 'FAIL: archiving a resume should not remove its resume_skill links (count=%)', v_count;
  end if;
  raise notice 'PASS: archived resume retains its resume_skill links';
end $$;

\echo '--- Test 10: candidate CANNOT SELECT another candidate''s resume (cross-candidate access blocked) ---'
do $$
declare v_uid_b uuid; v_cand_b uuid; v_uid_a uuid; v_resume_b_id uuid; v_count int;
begin
  select val into v_uid_b from resume_test_ids where key = 'user_b';
  select val into v_cand_b from resume_test_ids where key = 'cand_b';
  select val into v_uid_a from resume_test_ids where key = 'user_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.resume (candidate_id, label) values (v_cand_b, 'Data Science')
    returning id into v_resume_b_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.resume where id = v_resume_b_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s resume (count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot read user B''s resume';

  insert into resume_test_ids values ('resume_b_ds', v_resume_b_id);
end $$;

\echo '--- Test 11: candidate CANNOT UPDATE or DELETE another candidate''s resume ---'
do $$
declare v_uid_a uuid; v_resume_b_id uuid; v_rows_affected int; v_label text;
begin
  select val into v_uid_a from resume_test_ids where key = 'user_a';
  select val into v_resume_b_id from resume_test_ids where key = 'resume_b_ds';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;

  update public.resume set label = 'Hacked' where id = v_resume_b_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected != 0 then
    reset role;
    raise exception 'FAIL: user A updated user B''s resume (rows_affected=%)', v_rows_affected;
  end if;

  delete from public.resume where id = v_resume_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s resume (rows_affected=%)', v_rows_affected;
  end if;

  select label into v_label from public.resume where id = v_resume_b_id;
  if v_label != 'Data Science' then
    raise exception 'FAIL: user B''s resume was altered by user A''s attempts (label=%)', v_label;
  end if;
  raise notice 'PASS: user A cannot update or delete user B''s resume';
end $$;

\echo '--- Test 12: candidate CANNOT SELECT another candidate''s resume_skill rows ---'
do $$
declare v_uid_b uuid; v_uid_a uuid; v_resume_b_id uuid; v_skill_b_id uuid; v_rs_b_id uuid; v_count int;
begin
  select val into v_uid_b from resume_test_ids where key = 'user_b';
  select val into v_resume_b_id from resume_test_ids where key = 'resume_b_ds';
  select val into v_skill_b_id from resume_test_ids where key = 'skill_b_go';
  select val into v_uid_a from resume_test_ids where key = 'user_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.resume_skill (resume_id, skill_id) values (v_resume_b_id, v_skill_b_id)
    returning id into v_rs_b_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.resume_skill where id = v_rs_b_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s resume_skill row (count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot read user B''s resume_skill row';
end $$;

\echo '--- Test 13: anonymous (anon) role cannot read ANY resume or resume_skill rows ---'
do $$
declare v_count_resume int; v_count_rs int;
begin
  set local role anon;
  begin
    select count(*) into v_count_resume from public.resume;
  exception when insufficient_privilege then
    v_count_resume := -1; -- table-level grant denial is an equally valid pass
  end;
  begin
    select count(*) into v_count_rs from public.resume_skill;
  exception when insufficient_privilege then
    v_count_rs := -1;
  end;
  reset role;
  if v_count_resume > 0 then
    raise exception 'FAIL: anon role could read resume rows (count=%)', v_count_resume;
  end if;
  if v_count_rs > 0 then
    raise exception 'FAIL: anon role could read resume_skill rows (count=%)', v_count_rs;
  end if;
  raise notice 'PASS: anon role reads zero resume/resume_skill rows (denied at grant or RLS layer)';
end $$;

\echo '--- Test 14: anonymous (anon) role cannot INSERT a resume row ---'
do $$
declare failed boolean := false;
begin
  set local role anon;
  begin
    insert into public.resume (candidate_id, label) values (gen_random_uuid(), 'Anon Resume');
  exception when insufficient_privilege then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: anon role was able to insert a resume row';
  end if;
  raise notice 'PASS: anon role cannot insert a resume row';
end $$;

\echo '--- ALL RESUME TESTS PASSED ---'
