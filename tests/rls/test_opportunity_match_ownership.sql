-- test_opportunity_match_ownership.sql
-- Phase 1A/2A test suite: opportunity_match — the candidate-owned junction
-- table between a candidate and a canonical opportunity_source row
-- (0022_opportunity_intelligence_foundation.sql). Its RLS policies are the
-- same ownership-through-candidate pattern as public.opportunity, copied
-- verbatim per that migration's own comment — this suite mirrors
-- test_opportunity_ownership.sql's structure for that reason. The one
-- extra wrinkle: opportunity_match rows reference opportunity_source,
-- which authenticated has no INSERT policy for at all (see
-- test_opportunity_source_access.sql) — so every opportunity_source row
-- this suite needs is seeded as the connecting (superuser) role, the same
-- way service-role ingestion would write it, never as 'authenticated'.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- any other test suite.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning, and one active opportunity_source row (Opportunity Match suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
  source_id uuid;
  source_id_2 uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'match-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'match-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  -- Seeded as the connecting superuser role — mirrors service-role
  -- ingestion, which is the only way an opportunity_source row is ever
  -- created in production. See test_opportunity_source_access.sql.
  insert into public.opportunity_source (source_type, title, company, dedup_fingerprint, status)
  values ('job_board', 'Backend Engineering Intern', 'Acme Corp', 'match-test-source-1', 'active')
  returning id into source_id;

  -- A second source row, used only by Test 8 — needs a fresh
  -- (candidate, opportunity_source) pair so that test isn't accidentally
  -- blocked by the unique constraint exercised in Test 3, which would
  -- mask the actual thing Test 8 checks.
  insert into public.opportunity_source (source_type, title, company, dedup_fingerprint, status)
  values ('job_board', 'Data Science Intern', 'Zeta Labs', 'match-test-source-2', 'active')
  returning id into source_id_2;

  create temporary table match_test_ids (key text primary key, val uuid);
  insert into match_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                     ('cand_a', cand_a_id), ('cand_b', cand_b_id),
                                     ('source_1', source_id), ('source_2', source_id_2);
end $$;

\echo '--- Test 1: candidate can INSERT a valid opportunity_match against an active opportunity_source row (defaults: eligibility_status=unknown, inbox_status=new, is_priority=false) ---'
do $$
declare
  v_uid uuid; v_cand uuid; v_source uuid; v_id uuid;
  v_eligibility text; v_inbox_status text; v_priority boolean;
begin
  select val into v_uid from match_test_ids where key = 'user_a';
  select val into v_cand from match_test_ids where key = 'cand_a';
  select val into v_source from match_test_ids where key = 'source_1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.opportunity_match (candidate_id, opportunity_source_id, match_score)
  values (v_cand, v_source, 72.5)
  returning id into v_id;
  select eligibility_status, inbox_status, is_priority into v_eligibility, v_inbox_status, v_priority
    from public.opportunity_match where id = v_id;
  reset role;

  if v_eligibility != 'unknown' or v_inbox_status != 'new' or v_priority != false then
    raise exception 'FAIL: opportunity_match did not apply expected defaults (eligibility_status=%, inbox_status=%, is_priority=%)',
      v_eligibility, v_inbox_status, v_priority;
  end if;
  raise notice 'PASS: candidate can insert a valid opportunity_match with expected defaults';

  insert into match_test_ids values ('match_a1', v_id);
end $$;

\echo '--- Test 2: match_score outside 0-100 is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; v_source uuid; failed boolean := false;
begin
  select val into v_uid from match_test_ids where key = 'user_a';
  select val into v_cand from match_test_ids where key = 'cand_a';
  select val into v_source from match_test_ids where key = 'source_1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.opportunity_match (candidate_id, opportunity_source_id, match_score)
    values (v_cand, v_source, 137);
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an out-of-range match_score (137) was accepted by the DB';
  end if;
  raise notice 'PASS: match_score outside 0-100 is rejected';
end $$;

\echo '--- Test 3: a second match for the SAME (candidate, opportunity_source) pair is rejected (uq_opportunity_match_candidate_source_no_resume, the resume_id IS NULL partial index as of Gate R2) ---'
do $$
declare v_uid uuid; v_cand uuid; v_source uuid; failed boolean := false;
begin
  select val into v_uid from match_test_ids where key = 'user_a';
  select val into v_cand from match_test_ids where key = 'cand_a';
  select val into v_source from match_test_ids where key = 'source_1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.opportunity_match (candidate_id, opportunity_source_id, match_score)
    values (v_cand, v_source, 50);
  exception when unique_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a duplicate (candidate, opportunity_source) match was accepted by the DB — re-matching should update, not duplicate';
  end if;
  raise notice 'PASS: a duplicate (candidate, opportunity_source) match is rejected by the unique constraint';
end $$;

\echo '--- Test 4: candidate can update inbox_status (save), is_priority, and promoted_opportunity_id on their own match ---'
do $$
declare
  v_uid uuid; v_cand uuid; v_match_id uuid; v_opp_id uuid;
  v_inbox_status text; v_priority boolean; v_promoted uuid;
begin
  select val into v_uid from match_test_ids where key = 'user_a';
  select val into v_cand from match_test_ids where key = 'cand_a';
  select val into v_match_id from match_test_ids where key = 'match_a1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  -- The promoted opportunity must itself be one this candidate owns
  -- (mirrors the ownership check api/src/routes/opportunity-feed.ts
  -- performs before allowing this write at the API layer — this test
  -- exercises the DB-level FK/RLS reality that check depends on).
  insert into public.opportunity (candidate_id, title, company)
  values (v_cand, 'Backend Engineering Intern', 'Acme Corp')
  returning id into v_opp_id;

  update public.opportunity_match
    set inbox_status = 'saved', is_priority = true, promoted_opportunity_id = v_opp_id
    where id = v_match_id;
  select inbox_status, is_priority, promoted_opportunity_id into v_inbox_status, v_priority, v_promoted
    from public.opportunity_match where id = v_match_id;
  reset role;

  if v_inbox_status != 'saved' or v_priority != true or v_promoted != v_opp_id then
    raise exception 'FAIL: opportunity_match save/priority/promotion update did not persist';
  end if;
  raise notice 'PASS: candidate can save, prioritize, and promote their own match';

  insert into match_test_ids values ('opp_a1', v_opp_id);
end $$;

\echo '--- Test 5: deleting the promoted opportunity sets promoted_opportunity_id to NULL, not deleting the match (ON DELETE SET NULL) ---'
do $$
declare v_uid uuid; v_match_id uuid; v_opp_id uuid; v_promoted uuid; v_match_still_exists int;
begin
  select val into v_uid from match_test_ids where key = 'user_a';
  select val into v_match_id from match_test_ids where key = 'match_a1';
  select val into v_opp_id from match_test_ids where key = 'opp_a1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  delete from public.opportunity where id = v_opp_id;
  select promoted_opportunity_id into v_promoted from public.opportunity_match where id = v_match_id;
  select count(*) into v_match_still_exists from public.opportunity_match where id = v_match_id;
  reset role;

  if v_promoted is not null then
    raise exception 'FAIL: promoted_opportunity_id did not clear to NULL after the referenced opportunity was deleted';
  end if;
  if v_match_still_exists != 1 then
    raise exception 'FAIL: the opportunity_match row itself was removed — it should survive as historical, per ON DELETE SET NULL';
  end if;
  raise notice 'PASS: deleting the promoted opportunity clears promoted_opportunity_id but leaves the match record intact';
end $$;

\echo '--- Test 6: candidate CANNOT SELECT another candidate''s opportunity_match (cross-candidate access blocked) ---'
do $$
declare v_uid_b uuid; v_cand_b uuid; v_uid_a uuid; v_source uuid; v_match_b_id uuid; v_count int;
begin
  select val into v_uid_b from match_test_ids where key = 'user_b';
  select val into v_cand_b from match_test_ids where key = 'cand_b';
  select val into v_uid_a from match_test_ids where key = 'user_a';
  select val into v_source from match_test_ids where key = 'source_1';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.opportunity_match (candidate_id, opportunity_source_id, match_score)
  values (v_cand_b, v_source, 41) returning id into v_match_b_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.opportunity_match where id = v_match_b_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s opportunity_match (count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot read user B''s opportunity_match';

  insert into match_test_ids values ('match_b1', v_match_b_id);
end $$;

\echo '--- Test 7: candidate CANNOT UPDATE or DELETE another candidate''s opportunity_match ---'
do $$
declare v_uid_a uuid; v_match_b_id uuid; v_rows_affected int; v_count int;
begin
  select val into v_uid_a from match_test_ids where key = 'user_a';
  select val into v_match_b_id from match_test_ids where key = 'match_b1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;

  update public.opportunity_match set is_priority = true where id = v_match_b_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A updated user B''s opportunity_match (rows_affected=%)', v_rows_affected;
  end if;

  delete from public.opportunity_match where id = v_match_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s opportunity_match (rows_affected=%)', v_rows_affected;
  end if;

  select count(*) into v_count from public.opportunity_match where id = v_match_b_id;
  if v_count != 1 then
    raise exception 'FAIL: user B''s opportunity_match no longer exists after user A''s tampering attempts';
  end if;
  raise notice 'PASS: user A cannot update or delete user B''s opportunity_match';
end $$;

\echo '--- Test 8: candidate CANNOT set promoted_opportunity_id to an opportunity another candidate owns (FK existence check alone is not enough — RLS/API-layer ownership matters) ---'
do $$
declare v_uid_a uuid; v_uid_b uuid; v_cand_b uuid; v_opp_b_id uuid; v_source_2 uuid; v_cand_a uuid;
begin
  select val into v_uid_b from match_test_ids where key = 'user_b';
  select val into v_cand_b from match_test_ids where key = 'cand_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.opportunity (candidate_id, title, company)
  values (v_cand_b, 'Bob''s Private Opportunity', 'Delta Co') returning id into v_opp_b_id;
  reset role;

  select val into v_uid_a from match_test_ids where key = 'user_a';
  select val into v_cand_a from match_test_ids where key = 'cand_a';
  select val into v_source_2 from match_test_ids where key = 'source_2';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;

  -- NOTE: this INSERT succeeds at the raw DB layer — the FK on
  -- promoted_opportunity_id only checks the referenced row EXISTS, not
  -- that user A owns it (FK checks run outside RLS), and
  -- opportunity_source_id (source_2) is a real, valid, unused-by-cand_a
  -- row, so nothing else in this statement fails first. This is exactly
  -- why api/src/routes/opportunity-feed.ts performs an explicit
  -- RLS-scoped SELECT ownership check before ever writing this column
  -- (see its own comment) rather than relying on the FK alone. This test
  -- documents that reality rather than asserting a DB-level guarantee
  -- that does not exist — the enforcement point is the API route, not
  -- this table's constraints.
  insert into public.opportunity_match (candidate_id, opportunity_source_id, match_score, promoted_opportunity_id)
  values (v_cand_a, v_source_2, 60, v_opp_b_id);

  reset role;
  raise notice 'PASS (documentation test): DB layer alone permits cross-candidate promoted_opportunity_id — ownership enforcement is correctly the API route''s job, not this table''s constraints';
end $$;

\echo '--- Test 9: anon role cannot read ANY opportunity_match rows ---'
do $$
declare v_count int;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.opportunity_match;
  exception when insufficient_privilege then
    v_count := -1;
  end;
  reset role;
  if v_count > 0 then
    raise exception 'FAIL: anon role could read opportunity_match rows (count=%)', v_count;
  end if;
  raise notice 'PASS: anon role reads zero opportunity_match rows (denied at grant or RLS layer)';
end $$;

\echo '--- Gate R2 setup: one resume each for cand_a and cand_b, and a fresh source row (Test 3''s source_1 pair is already occupied by resume_id IS NULL) ---'
do $$
declare
  v_cand_a uuid; v_cand_b uuid; v_resume_a_id uuid; v_resume_b_id uuid; v_source_3 uuid;
begin
  select val into v_cand_a from match_test_ids where key = 'cand_a';
  select val into v_cand_b from match_test_ids where key = 'cand_b';

  insert into public.resume (candidate_id, label) values (v_cand_a, 'Software Development')
    returning id into v_resume_a_id;
  insert into public.resume (candidate_id, label) values (v_cand_b, 'Data Science')
    returning id into v_resume_b_id;

  insert into public.opportunity_source (source_type, title, company, dedup_fingerprint, status)
  values ('job_board', 'Platform Engineering Intern', 'Acme Corp', 'match-test-source-3', 'active')
  returning id into v_source_3;

  insert into match_test_ids values
    ('resume_a', v_resume_a_id), ('resume_b', v_resume_b_id), ('source_3', v_source_3);
end $$;

\echo '--- Test 10: opportunity_match.resume_id must belong to the SAME candidate as the match row (trigger, not RLS — RLS is bypassed by service-role writers) ---'
do $$
declare v_uid_a uuid; v_cand_a uuid; v_resume_b uuid; v_source_3 uuid; failed boolean := false;
begin
  select val into v_uid_a from match_test_ids where key = 'user_a';
  select val into v_cand_a from match_test_ids where key = 'cand_a';
  select val into v_resume_b from match_test_ids where key = 'resume_b'; -- belongs to cand_b, not cand_a
  select val into v_source_3 from match_test_ids where key = 'source_3';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  begin
    insert into public.opportunity_match (candidate_id, opportunity_source_id, resume_id, match_score)
    values (v_cand_a, v_source_3, v_resume_b, 50);
  exception when check_violation then
    failed := true;
  end;
  reset role;

  if not failed then
    raise exception 'FAIL: a match row was accepted with resume_id belonging to a DIFFERENT candidate';
  end if;
  raise notice 'PASS: resume_id must belong to the same candidate_id as the match row (trg_opportunity_match_resume_candidate)';
end $$;

\echo '--- Test 11: a candidate-level match (resume_id NULL) and a resume-scoped match for the SAME opportunity coexist (the entire point of Gate R2) ---'
do $$
declare v_uid_a uuid; v_cand_a uuid; v_resume_a uuid; v_source_3 uuid; v_count int;
begin
  select val into v_uid_a from match_test_ids where key = 'user_a';
  select val into v_cand_a from match_test_ids where key = 'cand_a';
  select val into v_resume_a from match_test_ids where key = 'resume_a';
  select val into v_source_3 from match_test_ids where key = 'source_3';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  -- Candidate-level row (resume_id NULL) for source_3.
  insert into public.opportunity_match (candidate_id, opportunity_source_id, resume_id, match_score)
  values (v_cand_a, v_source_3, null, 40);
  -- Resume-scoped row for the SAME candidate + SAME opportunity — must
  -- NOT collide with the row above; that is the whole reason Gate R2
  -- replaced the single unique constraint with two partial indexes.
  insert into public.opportunity_match (candidate_id, opportunity_source_id, resume_id, match_score)
  values (v_cand_a, v_source_3, v_resume_a, 90);

  select count(*) into v_count from public.opportunity_match
    where candidate_id = v_cand_a and opportunity_source_id = v_source_3;
  reset role;

  if v_count != 2 then
    raise exception 'FAIL: expected 2 coexisting rows (resume_id NULL + resume_id set) for the same (candidate, opportunity), got %', v_count;
  end if;
  raise notice 'PASS: a candidate-level match and a resume-scoped match for the same opportunity coexist without colliding';
end $$;

\echo '--- Test 12: a SECOND resume-scoped match for the SAME (candidate, opportunity_source, resume_id) is still rejected — uq_opportunity_match_candidate_source_resume ---'
do $$
declare v_uid_a uuid; v_cand_a uuid; v_resume_a uuid; v_source_3 uuid; failed boolean := false;
begin
  select val into v_uid_a from match_test_ids where key = 'user_a';
  select val into v_cand_a from match_test_ids where key = 'cand_a';
  select val into v_resume_a from match_test_ids where key = 'resume_a';
  select val into v_source_3 from match_test_ids where key = 'source_3';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  begin
    -- Duplicate of Test 11's second insert: same (candidate, source, resume).
    insert into public.opportunity_match (candidate_id, opportunity_source_id, resume_id, match_score)
    values (v_cand_a, v_source_3, v_resume_a, 10);
  exception when unique_violation then
    failed := true;
  end;
  reset role;

  if not failed then
    raise exception 'FAIL: a duplicate (candidate, opportunity_source, resume_id) match was accepted';
  end if;
  raise notice 'PASS: a duplicate resume-scoped match is rejected by uq_opportunity_match_candidate_source_resume';
end $$;

\echo '--- ALL OPPORTUNITY_MATCH TESTS PASSED ---'
