-- test_application_ownership.sql
-- Phase 1 test suite: Application entity — valid creation (defaults to
-- SAVED), the full status transition trigger (legal/illegal transitions,
-- terminal states, applied_at side effect), the one-application-per-
-- opportunity-per-candidate constraint, ownership, cross-candidate access,
-- and anonymous access.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users + opportunities), does not
-- depend on or modify any other test suite.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning + opportunities (Application suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
  opp_a_id uuid;
  opp_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'app-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'app-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', user_a_id)::text, true);
  set local role authenticated;
  insert into public.opportunity (candidate_id, title, company)
  values (cand_a_id, 'Backend Intern', 'Acme Corp') returning id into opp_a_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', user_b_id)::text, true);
  set local role authenticated;
  insert into public.opportunity (candidate_id, title, company)
  values (cand_b_id, 'Bob''s Lead', 'Delta Co') returning id into opp_b_id;
  reset role;

  create temporary table app_test_ids (key text primary key, val uuid);
  insert into app_test_ids values
    ('user_a', user_a_id), ('user_b', user_b_id),
    ('cand_a', cand_a_id), ('cand_b', cand_b_id),
    ('opp_a', opp_a_id), ('opp_b', opp_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT an application for their own opportunity (defaults to SAVED, applied_at null) ---'
do $$
declare v_uid uuid; v_cand uuid; v_opp uuid; v_id uuid; v_status text; v_applied_at timestamptz;
begin
  select val into v_uid from app_test_ids where key = 'user_a';
  select val into v_cand from app_test_ids where key = 'cand_a';
  select val into v_opp from app_test_ids where key = 'opp_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.application (candidate_id, opportunity_id) values (v_cand, v_opp) returning id into v_id;
  select status, applied_at into v_status, v_applied_at from public.application where id = v_id;
  reset role;

  if v_status != 'SAVED' or v_applied_at is not null then
    raise exception 'FAIL: new application did not default to SAVED with null applied_at (status=%, applied_at=%)', v_status, v_applied_at;
  end if;
  raise notice 'PASS: candidate can insert an application, defaults to SAVED with null applied_at';

  insert into app_test_ids values ('app_a1', v_id);
end $$;

\echo '--- Test 2: a second application for the SAME opportunity by the SAME candidate is rejected (uq_application_candidate_opportunity) ---'
do $$
declare v_uid uuid; v_cand uuid; v_opp uuid; failed boolean := false;
begin
  select val into v_uid from app_test_ids where key = 'user_a';
  select val into v_cand from app_test_ids where key = 'cand_a';
  select val into v_opp from app_test_ids where key = 'opp_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.application (candidate_id, opportunity_id) values (v_cand, v_opp);
  exception when unique_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a duplicate application for the same opportunity was accepted';
  end if;
  raise notice 'PASS: duplicate application for the same opportunity is rejected';
end $$;

\echo '--- Test 3: legal transition chain SAVED -> APPLYING -> APPLIED sets applied_at ---'
do $$
declare v_uid uuid; v_app_id uuid; v_status text; v_applied_at timestamptz;
begin
  select val into v_uid from app_test_ids where key = 'user_a';
  select val into v_app_id from app_test_ids where key = 'app_a1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  update public.application set status = 'APPLYING' where id = v_app_id;
  update public.application set status = 'APPLIED' where id = v_app_id;
  select status, applied_at into v_status, v_applied_at from public.application where id = v_app_id;
  reset role;
  if v_status != 'APPLIED' or v_applied_at is null then
    raise exception 'FAIL: SAVED -> APPLYING -> APPLIED did not apply or did not set applied_at (status=%, applied_at=%)', v_status, v_applied_at;
  end if;
  raise notice 'PASS: SAVED -> APPLYING -> APPLIED applies and sets applied_at';
end $$;

\echo '--- Test 4: illegal transition (APPLIED -> SAVED) is rejected ---'
do $$
declare v_uid uuid; v_app_id uuid; failed boolean := false;
begin
  select val into v_uid from app_test_ids where key = 'user_a';
  select val into v_app_id from app_test_ids where key = 'app_a1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    update public.application set status = 'SAVED' where id = v_app_id;
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: illegal transition APPLIED -> SAVED was accepted';
  end if;
  raise notice 'PASS: illegal transition APPLIED -> SAVED is rejected';
end $$;

\echo '--- Test 5: APPLIED -> INTERVIEW -> OFFER is legal; OFFER is terminal (no outgoing transition) ---'
do $$
declare v_uid uuid; v_app_id uuid; v_status text; failed boolean := false;
begin
  select val into v_uid from app_test_ids where key = 'user_a';
  select val into v_app_id from app_test_ids where key = 'app_a1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  update public.application set status = 'INTERVIEW' where id = v_app_id;
  update public.application set status = 'OFFER' where id = v_app_id;
  select status into v_status from public.application where id = v_app_id;

  begin
    update public.application set status = 'APPLIED' where id = v_app_id;
  exception when check_violation then
    failed := true;
  end;
  reset role;

  if v_status != 'OFFER' then
    raise exception 'FAIL: APPLIED -> INTERVIEW -> OFFER did not apply (status=%)', v_status;
  end if;
  if not failed then
    raise exception 'FAIL: OFFER -> APPLIED (transition out of terminal state) was accepted';
  end if;
  raise notice 'PASS: APPLIED -> INTERVIEW -> OFFER applies; OFFER is terminal';
end $$;

\echo '--- Test 6: same-status update (ordinary field edit) is always allowed, does not touch applied_at ---'
do $$
declare v_uid uuid; v_app_id uuid; v_applied_at_before timestamptz; v_applied_at_after timestamptz; v_note text;
begin
  select val into v_uid from app_test_ids where key = 'user_a';
  select val into v_app_id from app_test_ids where key = 'app_a1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  select applied_at into v_applied_at_before from public.application where id = v_app_id;
  update public.application set next_action_note = 'Follow up after onsite.' where id = v_app_id;
  select applied_at, next_action_note into v_applied_at_after, v_note from public.application where id = v_app_id;
  reset role;
  if v_applied_at_before is distinct from v_applied_at_after then
    raise exception 'FAIL: an ordinary field edit changed applied_at';
  end if;
  if v_note != 'Follow up after onsite.' then
    raise exception 'FAIL: ordinary field edit did not persist';
  end if;
  raise notice 'PASS: same-status field edits are allowed and do not disturb applied_at';
end $$;

\echo '--- Test 7: a fresh application can go straight to WITHDRAWN from SAVED, and WITHDRAWN is terminal ---'
do $$
declare v_uid uuid; v_cand uuid; v_opp uuid; v_id uuid; v_status text; failed boolean := false;
begin
  select val into v_uid from app_test_ids where key = 'user_b';
  select val into v_cand from app_test_ids where key = 'cand_b';
  select val into v_opp from app_test_ids where key = 'opp_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.application (candidate_id, opportunity_id) values (v_cand, v_opp) returning id into v_id;
  update public.application set status = 'WITHDRAWN' where id = v_id;
  select status into v_status from public.application where id = v_id;

  begin
    update public.application set status = 'APPLYING' where id = v_id;
  exception when check_violation then
    failed := true;
  end;
  reset role;

  if v_status != 'WITHDRAWN' then
    raise exception 'FAIL: SAVED -> WITHDRAWN did not apply (status=%)', v_status;
  end if;
  if not failed then
    raise exception 'FAIL: WITHDRAWN -> APPLYING (transition out of terminal state) was accepted';
  end if;
  raise notice 'PASS: SAVED -> WITHDRAWN applies; WITHDRAWN is terminal';

  insert into app_test_ids values ('app_b1', v_id);
end $$;

\echo '--- Test 8: candidate CANNOT SELECT/UPDATE/DELETE another candidate''s application (cross-candidate access blocked) ---'
do $$
declare v_uid_a uuid; v_app_b_id uuid; v_count int; v_rows_affected int;
begin
  select val into v_uid_a from app_test_ids where key = 'user_a';
  select val into v_app_b_id from app_test_ids where key = 'app_b1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.application where id = v_app_b_id;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s application (count=%)', v_count;
  end if;

  update public.application set next_action_note = 'hacked' where id = v_app_b_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A updated user B''s application (rows_affected=%)', v_rows_affected;
  end if;

  delete from public.application where id = v_app_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s application (rows_affected=%)', v_rows_affected;
  end if;
  raise notice 'PASS: user A cannot read, update, or delete user B''s application';
end $$;

\echo '--- Test 9: anon role cannot read ANY application rows ---'
do $$
declare v_count int;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.application;
  exception when insufficient_privilege then
    v_count := -1;
  end;
  reset role;
  if v_count > 0 then
    raise exception 'FAIL: anon role could read application rows (count=%)', v_count;
  end if;
  raise notice 'PASS: anon role reads zero application rows (denied at grant or RLS layer)';
end $$;

\echo '--- Gate R4 setup: one resume each for cand_a and cand_b, and a fresh opportunity for the coexistence test ---'
do $$
declare
  v_cand_a uuid; v_cand_b uuid; v_resume_a_id uuid; v_resume_b_id uuid; v_opp_c uuid;
begin
  select val into v_cand_a from app_test_ids where key = 'cand_a';
  select val into v_cand_b from app_test_ids where key = 'cand_b';

  insert into public.resume (candidate_id, label) values (v_cand_a, 'Software Development')
    returning id into v_resume_a_id;
  insert into public.resume (candidate_id, label) values (v_cand_b, 'Data Science')
    returning id into v_resume_b_id;

  insert into public.opportunity (candidate_id, title, company)
  values (v_cand_a, 'Platform Intern', 'Gamma LLC') returning id into v_opp_c;

  insert into app_test_ids values
    ('resume_a', v_resume_a_id), ('resume_b', v_resume_b_id), ('opp_c', v_opp_c);
end $$;

\echo '--- Test 10: candidate can create an application with resume_id set to their OWN resume ---'
do $$
declare v_uid uuid; v_cand uuid; v_opp uuid; v_resume uuid; v_id uuid; v_stored_resume uuid;
begin
  select val into v_uid from app_test_ids where key = 'user_a';
  select val into v_cand from app_test_ids where key = 'cand_a';
  select val into v_opp from app_test_ids where key = 'opp_c';
  select val into v_resume from app_test_ids where key = 'resume_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.application (candidate_id, opportunity_id, resume_id)
  values (v_cand, v_opp, v_resume)
  returning id into v_id;
  select resume_id into v_stored_resume from public.application where id = v_id;
  reset role;

  if v_stored_resume != v_resume then
    raise exception 'FAIL: application.resume_id did not persist as inserted';
  end if;
  raise notice 'PASS: candidate can create an application with resume_id set to their own resume';
end $$;

\echo '--- Test 11: application.resume_id must belong to the SAME candidate as the application (trigger) ---'
do $$
declare v_uid_a uuid; v_cand_a uuid; v_opp uuid; v_resume_b uuid; failed boolean := false;
begin
  select val into v_uid_a from app_test_ids where key = 'user_a';
  select val into v_cand_a from app_test_ids where key = 'cand_a';
  select val into v_opp from app_test_ids where key = 'opp_a';
  select val into v_resume_b from app_test_ids where key = 'resume_b'; -- belongs to cand_b, not cand_a

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  begin
    insert into public.application (candidate_id, opportunity_id, resume_id)
    values (v_cand_a, v_opp, v_resume_b);
  exception when check_violation then
    failed := true;
  end;
  reset role;

  if not failed then
    raise exception 'FAIL: an application was accepted with resume_id belonging to a DIFFERENT candidate';
  end if;
  raise notice 'PASS: application.resume_id must belong to the same candidate_id (trg_application_resume_candidate)';
end $$;

\echo '--- Test 12: deleting a resume sets resume_id to NULL on its applications — history preserved, not deleted or blocked ---'
do $$
declare v_uid uuid; v_cand uuid; v_opp uuid; v_resume uuid; v_app_id uuid; v_resume_after uuid; v_status_after text;
begin
  select val into v_uid from app_test_ids where key = 'user_a';
  select val into v_cand from app_test_ids where key = 'cand_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  -- Fresh opportunity, not opp_a/opp_c — both already have an application
  -- from earlier tests in this file, and uq_application_candidate_opportunity
  -- rejects a second one for the same (candidate, opportunity) pair.
  insert into public.opportunity (candidate_id, title, company)
  values (v_cand, 'Resume Deletion Test Intern', 'Delta Inc') returning id into v_opp;
  insert into public.resume (candidate_id, label) values (v_cand, 'Disposable Resume') returning id into v_resume;
  insert into public.application (candidate_id, opportunity_id, resume_id)
  values (v_cand, v_opp, v_resume)
  returning id into v_app_id;

  delete from public.resume where id = v_resume;

  select resume_id, status into v_resume_after, v_status_after from public.application where id = v_app_id;
  reset role;

  if v_resume_after is not null then
    raise exception 'FAIL: application.resume_id was not cleared after its resume was deleted (got %)', v_resume_after;
  end if;
  if v_status_after is null then
    raise exception 'FAIL: the application row itself was deleted (or unreadable) when its resume was deleted — history was NOT preserved';
  end if;
  raise notice 'PASS: deleting a resume clears application.resume_id (ON DELETE SET NULL) without deleting the application itself';
end $$;

\echo '--- ALL APPLICATION TESTS PASSED ---'
