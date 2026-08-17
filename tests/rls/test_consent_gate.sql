-- test_consent_gate.sql
-- Consent gate suite: proves personal_info INSERT/UPDATE require an active
-- (unrevoked) data_processing consent_record (0014_consent_gate_personal_info.sql),
-- that SELECT is unaffected by consent state, and that a consent of the
-- wrong type does not satisfy the gate.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- the Day 1 or Day 2 entity test suites.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (Consent Gate suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'cg-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'cg-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table cg_test_ids (key text primary key, val uuid);
  insert into cg_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                  ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate CANNOT INSERT personal_info with no consent_record at all ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from cg_test_ids where key = 'user_a';
  select val into v_cand from cg_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.personal_info (candidate_id, legal_first_name, legal_last_name, email, location_country)
    values (v_cand, 'Alice', 'Gate', 'cg-alice@example.edu', 'US');
  exception when others then
    failed := true;
  end;
  reset role;
  if not failed then
    perform 1 from public.personal_info where candidate_id = v_cand;
    if found then
      raise exception 'FAIL: personal_info insert succeeded with no active data_processing consent';
    end if;
  end if;
  raise notice 'PASS: personal_info insert is blocked with no active data_processing consent';
end $$;

\echo '--- Test 2: a consent of the WRONG type does not satisfy the gate ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from cg_test_ids where key = 'user_b';
  select val into v_cand from cg_test_ids where key = 'cand_b';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.consent_record (candidate_id, consent_type, version)
  values (v_cand, 'github_oauth_access', 'v1.0');

  begin
    insert into public.personal_info (candidate_id, legal_first_name, legal_last_name, email, location_country)
    values (v_cand, 'Bob', 'Gate', 'cg-bob@example.edu', 'US');
  exception when others then
    failed := true;
  end;
  reset role;
  if not failed then
    perform 1 from public.personal_info where candidate_id = v_cand;
    if found then
      raise exception 'FAIL: personal_info insert succeeded with only a github_oauth_access consent (wrong type)';
    end if;
  end if;
  raise notice 'PASS: a consent of the wrong type does not satisfy the data_processing gate';
end $$;

\echo '--- Test 3: candidate CAN INSERT personal_info once active data_processing consent exists ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from cg_test_ids where key = 'user_a';
  select val into v_cand from cg_test_ids where key = 'cand_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.consent_record (candidate_id, consent_type, version)
  values (v_cand, 'data_processing', 'v1.0');

  insert into public.personal_info (candidate_id, legal_first_name, legal_last_name, email, location_country)
  values (v_cand, 'Alice', 'Gate', 'cg-alice@example.edu', 'US');
  reset role;

  select count(*) into v_count from public.personal_info where candidate_id = v_cand;
  if v_count != 1 then
    raise exception 'FAIL: personal_info insert did not persist with an active data_processing consent';
  end if;
  raise notice 'PASS: personal_info insert succeeds with an active data_processing consent';
end $$;

\echo '--- Test 4: candidate CANNOT UPDATE personal_info after revoking data_processing consent ---'
-- Note: this UPDATE passes the USING clause (the candidate owns the row)
-- but fails WITH CHECK (no active consent on the post-update row), which
-- is a distinct RLS failure mode from Test 1/2's blocked INSERT — Postgres
-- raises "new row violates row-level security policy" here rather than
-- silently affecting 0 rows, so the update must be wrapped to catch it.
do $$
declare v_uid uuid; v_cand uuid; v_last_name text;
begin
  select val into v_uid from cg_test_ids where key = 'user_a';
  select val into v_cand from cg_test_ids where key = 'cand_a';

  -- revoke the consent granted in Test 3
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  update public.consent_record set revoked_at = now()
    where candidate_id = v_cand and consent_type = 'data_processing' and revoked_at is null;

  begin
    update public.personal_info set legal_last_name = 'ShouldNotApply' where candidate_id = v_cand;
  exception when others then
    null; -- expected: RLS WITH CHECK rejects the update
  end;
  reset role;

  select legal_last_name into v_last_name from public.personal_info where candidate_id = v_cand;
  if v_last_name = 'ShouldNotApply' then
    raise exception 'FAIL: personal_info update succeeded after data_processing consent was revoked';
  end if;
  raise notice 'PASS: personal_info update is blocked once data_processing consent is revoked';
end $$;

\echo '--- Test 5: SELECT is unaffected — candidate can still read personal_info with revoked consent ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from cg_test_ids where key = 'user_a';
  select val into v_cand from cg_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.personal_info where candidate_id = v_cand;
  reset role;
  if v_count != 1 then
    raise exception 'FAIL: candidate could not read their own already-stored personal_info after revoking consent';
  end if;
  raise notice 'PASS: personal_info remains readable after consent revocation (revocation blocks writes, not reads)';
end $$;

\echo '--- Test 6: re-granting data_processing consent restores UPDATE access ---'
do $$
declare v_uid uuid; v_cand uuid; v_last_name text;
begin
  select val into v_uid from cg_test_ids where key = 'user_a';
  select val into v_cand from cg_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.consent_record (candidate_id, consent_type, version)
  values (v_cand, 'data_processing', 'v1.1');

  update public.personal_info set legal_last_name = 'Regranted' where candidate_id = v_cand;
  select legal_last_name into v_last_name from public.personal_info where candidate_id = v_cand;
  reset role;

  if v_last_name != 'Regranted' then
    raise exception 'FAIL: personal_info update did not succeed after re-granting data_processing consent';
  end if;
  raise notice 'PASS: re-granting data_processing consent restores write access';
end $$;

\echo '--- ALL CONSENT GATE TESTS PASSED ---'
