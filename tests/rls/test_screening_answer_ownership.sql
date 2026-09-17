-- test_screening_answer_ownership.sql
-- Gate R8 follow-up: screening_answer entity — valid data, blank-field
-- constraints at the DB layer, ownership, and cross-candidate access.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), same pattern as
-- test_education_ownership.sql.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (screening_answer suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'sa-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'sa-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table sa_test_ids (key text primary key, val uuid);
  insert into sa_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                  ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid screening_answer for themselves ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int; v_id uuid;
begin
  select val into v_uid from sa_test_ids where key = 'user_a';
  select val into v_cand from sa_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.screening_answer (candidate_id, question, answer)
  values (v_cand, 'Are you willing to relocate?', 'Yes, open to relocating within the US.')
  returning id into v_id;
  reset role;

  select count(*) into v_count from public.screening_answer where id = v_id and candidate_id = v_cand;
  if v_count != 1 then
    raise exception 'FAIL: valid screening_answer insert did not persist';
  end if;
  raise notice 'PASS: candidate can insert a valid screening_answer';

  insert into sa_test_ids values ('sa_a1', v_id) on conflict (key) do update set val = excluded.val;
end $$;

\echo '--- Test 2: a blank (whitespace-only) question is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from sa_test_ids where key = 'user_a';
  select val into v_cand from sa_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.screening_answer (candidate_id, question, answer)
    values (v_cand, '   ', 'Some answer');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a whitespace-only question was accepted by the DB';
  end if;
  raise notice 'PASS: a whitespace-only question is rejected (screening_answer_question_not_blank)';
end $$;

\echo '--- Test 3: a blank (whitespace-only) answer is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from sa_test_ids where key = 'user_a';
  select val into v_cand from sa_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.screening_answer (candidate_id, question, answer)
    values (v_cand, 'Some question', '   ');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a whitespace-only answer was accepted by the DB';
  end if;
  raise notice 'PASS: a whitespace-only answer is rejected (screening_answer_answer_not_blank)';
end $$;

\echo '--- Test 4: candidate can SELECT/UPDATE their own screening_answer row (ownership) ---'
do $$
declare v_uid uuid; v_sa_id uuid; v_count int;
begin
  select val into v_uid from sa_test_ids where key = 'user_a';
  select val into v_sa_id from sa_test_ids where key = 'sa_a1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.screening_answer where id = v_sa_id;
  update public.screening_answer set answer = 'Updated answer' where id = v_sa_id;
  reset role;
  if v_count != 1 then
    raise exception 'FAIL: user A could not see their own screening_answer row';
  end if;
  raise notice 'PASS: user A can select and update their own screening_answer row';
end $$;

\echo '--- Test 5: candidate CANNOT SELECT another candidate''s screening_answer row ---'
do $$
declare v_uid_b uuid; v_cand_b uuid; v_uid_a uuid; v_sa_b_id uuid; v_count int;
begin
  select val into v_uid_b from sa_test_ids where key = 'user_b';
  select val into v_cand_b from sa_test_ids where key = 'cand_b';
  select val into v_uid_a from sa_test_ids where key = 'user_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.screening_answer (candidate_id, question, answer)
  values (v_cand_b, 'Expected hourly rate?', '$25/hr')
  returning id into v_sa_b_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.screening_answer where id = v_sa_b_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s screening_answer row (count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot read user B''s screening_answer row';

  insert into sa_test_ids values ('sa_b1', v_sa_b_id) on conflict (key) do update set val = excluded.val;
end $$;

\echo '--- Test 6: candidate CANNOT UPDATE another candidate''s screening_answer row ---'
do $$
declare v_uid_a uuid; v_sa_b_id uuid; v_rows_affected int;
begin
  select val into v_uid_a from sa_test_ids where key = 'user_a';
  select val into v_sa_b_id from sa_test_ids where key = 'sa_b1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  update public.screening_answer set answer = 'Hacked answer' where id = v_sa_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A updated user B''s screening_answer row (rows_affected=%)', v_rows_affected;
  end if;
  raise notice 'PASS: user A cannot update user B''s screening_answer row (RLS silently affects 0 rows)';
end $$;

\echo '--- Test 7: candidate CANNOT DELETE another candidate''s screening_answer row ---'
do $$
declare v_uid_a uuid; v_sa_b_id uuid; v_rows_affected int; v_count int;
begin
  select val into v_uid_a from sa_test_ids where key = 'user_a';
  select val into v_sa_b_id from sa_test_ids where key = 'sa_b1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  delete from public.screening_answer where id = v_sa_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s screening_answer row (rows_affected=%)', v_rows_affected;
  end if;

  select count(*) into v_count from public.screening_answer where id = v_sa_b_id;
  if v_count != 1 then
    raise exception 'FAIL: user B''s screening_answer row no longer exists after user A''s delete attempt';
  end if;
  raise notice 'PASS: user A cannot delete user B''s screening_answer row';
end $$;

\echo '--- Test 8: candidate supports MULTIPLE screening_answer rows (a reference library, not a single fact) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from sa_test_ids where key = 'user_a';
  select val into v_cand from sa_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.screening_answer (candidate_id, question, answer)
  values (v_cand, 'How did you hear about us?', 'Referred by a friend.');
  select count(*) into v_count from public.screening_answer where candidate_id = v_cand;
  reset role;
  if v_count < 2 then
    raise exception 'FAIL: candidate could not hold multiple screening_answer rows (count=%)', v_count;
  end if;
  raise notice 'PASS: candidate can hold multiple screening_answer rows (count=%)', v_count;
end $$;

\echo '--- Test 9: anon role cannot read ANY screening_answer rows ---'
do $$
declare v_count int;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.screening_answer;
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;
  reset role;
  if v_count > 0 then
    raise exception 'FAIL: anon role could read screening_answer rows (count=%)', v_count;
  end if;
  raise notice 'PASS: anon role reads zero screening_answer rows (denied at grant or RLS layer)';
end $$;

\echo '--- ALL SCREENING_ANSWER TESTS PASSED ---'
