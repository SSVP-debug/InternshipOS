-- test_application_note_ownership.sql
-- Phase 1 test suite: Application notes — valid creation, validation,
-- edit (update, unlike status_event), delete, multiple notes per
-- application, ownership, cross-candidate access, and anonymous access.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users + opportunities + applications).

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning + opportunity + application (Note suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
  opp_a_id uuid;
  app_a_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'note-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'note-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', user_a_id)::text, true);
  set local role authenticated;
  insert into public.opportunity (candidate_id, title, company)
  values (cand_a_id, 'Design Intern', 'Acme Corp') returning id into opp_a_id;
  insert into public.application (candidate_id, opportunity_id) values (cand_a_id, opp_a_id) returning id into app_a_id;
  reset role;

  create temporary table note_test_ids (key text primary key, val uuid);
  insert into note_test_ids values
    ('user_a', user_a_id), ('user_b', user_b_id),
    ('cand_a', cand_a_id), ('cand_b', cand_b_id),
    ('app_a', app_a_id);
end $$;

\echo '--- Test 1: candidate can INSERT a note on their own application (defaults note_type=general) ---'
do $$
declare v_uid uuid; v_cand uuid; v_app uuid; v_id uuid; v_type text;
begin
  select val into v_uid from note_test_ids where key = 'user_a';
  select val into v_cand from note_test_ids where key = 'cand_a';
  select val into v_app from note_test_ids where key = 'app_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.application_note (application_id, candidate_id, content)
  values (v_app, v_cand, 'Recruiter said decision expected next Friday.')
  returning id into v_id;
  select note_type into v_type from public.application_note where id = v_id;
  reset role;
  if v_type != 'general' then
    raise exception 'FAIL: note did not default to note_type=general (got %)', v_type;
  end if;
  raise notice 'PASS: candidate can insert a note, defaults to note_type=general';

  insert into note_test_ids values ('note_a1', v_id);
end $$;

\echo '--- Test 2: blank content is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; v_app uuid; failed boolean := false;
begin
  select val into v_uid from note_test_ids where key = 'user_a';
  select val into v_cand from note_test_ids where key = 'cand_a';
  select val into v_app from note_test_ids where key = 'app_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.application_note (application_id, candidate_id, content) values (v_app, v_cand, '   ');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: blank note content was accepted by the DB';
  end if;
  raise notice 'PASS: blank note content is rejected';
end $$;

\echo '--- Test 3: invalid note_type is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; v_app uuid; failed boolean := false;
begin
  select val into v_uid from note_test_ids where key = 'user_a';
  select val into v_cand from note_test_ids where key = 'cand_a';
  select val into v_app from note_test_ids where key = 'app_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.application_note (application_id, candidate_id, note_type, content)
    values (v_app, v_cand, 'gossip', 'Something informal.');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an invalid note_type was accepted by the DB';
  end if;
  raise notice 'PASS: invalid note_type is rejected';
end $$;

\echo '--- Test 4: candidate can UPDATE (edit) and DELETE their own note — unlike status_event, notes are not permanent ---'
do $$
declare v_uid uuid; v_note_id uuid; v_content text; v_count int;
begin
  select val into v_uid from note_test_ids where key = 'user_a';
  select val into v_note_id from note_test_ids where key = 'note_a1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  update public.application_note set content = 'Recruiter said decision expected next Monday (corrected).' where id = v_note_id;
  select content into v_content from public.application_note where id = v_note_id;
  reset role;
  if v_content != 'Recruiter said decision expected next Monday (corrected).' then
    raise exception 'FAIL: note edit did not persist';
  end if;
  raise notice 'PASS: candidate can edit their own note';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  delete from public.application_note where id = v_note_id;
  reset role;
  select count(*) into v_count from public.application_note where id = v_note_id;
  if v_count != 0 then
    raise exception 'FAIL: candidate could not delete their own note';
  end if;
  raise notice 'PASS: candidate can delete their own note';
end $$;

\echo '--- Test 5: candidate supports MULTIPLE notes per application ---'
do $$
declare v_uid uuid; v_cand uuid; v_app uuid; v_count int;
begin
  select val into v_uid from note_test_ids where key = 'user_a';
  select val into v_cand from note_test_ids where key = 'cand_a';
  select val into v_app from note_test_ids where key = 'app_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.application_note (application_id, candidate_id, note_type, content)
  values (v_app, v_cand, 'recruiter_contact', 'Jane Doe, jane@acme.example');
  insert into public.application_note (application_id, candidate_id, note_type, content)
  values (v_app, v_cand, 'link', 'https://acme.example/careers/123');
  select count(*) into v_count from public.application_note where application_id = v_app;
  reset role;
  if v_count < 2 then
    raise exception 'FAIL: application could not hold multiple notes (count=%)', v_count;
  end if;
  raise notice 'PASS: application can hold multiple notes (count=%)', v_count;

  insert into note_test_ids values ('note_a2', (select id from public.application_note where application_id = v_app and note_type = 'link'));
end $$;

\echo '--- Test 6: candidate CANNOT SELECT/UPDATE/DELETE another candidate''s notes (cross-candidate access blocked) ---'
do $$
declare v_uid_b uuid; v_note_a2 uuid; v_count int; v_rows_affected int;
begin
  select val into v_uid_b from note_test_ids where key = 'user_b';
  select val into v_note_a2 from note_test_ids where key = 'note_a2';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.application_note where id = v_note_a2;
  if v_count != 0 then
    raise exception 'FAIL: user B could read user A''s note (count=%)', v_count;
  end if;

  update public.application_note set content = 'hacked' where id = v_note_a2;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user B updated user A''s note (rows_affected=%)', v_rows_affected;
  end if;

  delete from public.application_note where id = v_note_a2;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user B deleted user A''s note (rows_affected=%)', v_rows_affected;
  end if;
  raise notice 'PASS: user B cannot read, update, or delete user A''s note';
end $$;

\echo '--- Test 7: anon role cannot read ANY note rows ---'
do $$
declare v_count int;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.application_note;
  exception when insufficient_privilege then
    v_count := -1;
  end;
  reset role;
  if v_count > 0 then
    raise exception 'FAIL: anon role could read application_note rows (count=%)', v_count;
  end if;
  raise notice 'PASS: anon role reads zero application_note rows (denied at grant or RLS layer)';
end $$;

\echo '--- ALL APPLICATION NOTE TESTS PASSED ---'
