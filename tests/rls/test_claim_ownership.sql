-- test_claim_ownership.sql
-- Day 4 test suite: Claim entity — valid creation (defaults to DRAFT),
-- multiple claims, validation failures, the full ClaimStatus transition
-- trigger (legal and illegal transitions, terminal states, last_reviewed_at
-- side effect), permanence (no DELETE policy at all), cross-candidate
-- access, and anonymous access.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- any other test suite.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (Claim suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'claim-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'claim-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table claim_test_ids (key text primary key, val uuid);
  insert into claim_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                     ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid claim (defaults to DRAFT, last_reviewed_at null) ---'
do $$
declare v_uid uuid; v_cand uuid; v_id uuid; v_status text; v_reviewed timestamptz;
begin
  select val into v_uid from claim_test_ids where key = 'user_a';
  select val into v_cand from claim_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.claim (candidate_id, subject_entity_type, subject_entity_id, claim_text)
  values (v_cand, 'project', gen_random_uuid(), 'Built a full-stack platform using React and Node.js.')
  returning id into v_id;
  select status, last_reviewed_at into v_status, v_reviewed from public.claim where id = v_id;
  reset role;

  if v_status != 'DRAFT' or v_reviewed is not null then
    raise exception 'FAIL: new claim did not default to DRAFT with null last_reviewed_at (status=%, last_reviewed_at=%)', v_status, v_reviewed;
  end if;
  raise notice 'PASS: candidate can insert a valid claim, defaults to DRAFT with null last_reviewed_at';

  insert into claim_test_ids values ('claim_a_project', v_id);
end $$;

\echo '--- Test 2: candidate supports MULTIPLE claims (not just one) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from claim_test_ids where key = 'user_a';
  select val into v_cand from claim_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.claim (candidate_id, subject_entity_type, subject_entity_id, claim_text)
  values (v_cand, 'skill', gen_random_uuid(), 'Proficient in TypeScript.');
  select count(*) into v_count from public.claim where candidate_id = v_cand;
  reset role;
  if v_count < 2 then
    raise exception 'FAIL: candidate could not hold multiple claims (count=%)', v_count;
  end if;
  raise notice 'PASS: candidate can hold multiple claims (count=%)', v_count;
end $$;

\echo '--- Test 3: validation failure — empty claim_text is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from claim_test_ids where key = 'user_a';
  select val into v_cand from claim_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.claim (candidate_id, subject_entity_type, subject_entity_id, claim_text)
    values (v_cand, 'skill', gen_random_uuid(), '   ');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an empty/whitespace-only claim_text was accepted by the DB';
  end if;
  raise notice 'PASS: empty/whitespace-only claim_text is rejected by the DB check constraint';
end $$;

\echo '--- Test 4: validation failure — invalid subject_entity_type is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from claim_test_ids where key = 'user_a';
  select val into v_cand from claim_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.claim (candidate_id, subject_entity_type, subject_entity_id, claim_text)
    values (v_cand, 'hobby', gen_random_uuid(), 'Some claim.');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an invalid subject_entity_type enum value was accepted by the DB';
  end if;
  raise notice 'PASS: invalid subject_entity_type enum value is rejected by the DB check constraint';
end $$;

\echo '--- Test 5: ClaimStatus — DRAFT to CONFIRMED is legal and sets last_reviewed_at ---'
do $$
declare v_uid uuid; v_id uuid; v_status text; v_reviewed timestamptz;
begin
  select val into v_uid from claim_test_ids where key = 'user_a';
  select val into v_id from claim_test_ids where key = 'claim_a_project';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  update public.claim set status = 'CONFIRMED' where id = v_id;
  select status, last_reviewed_at into v_status, v_reviewed from public.claim where id = v_id;
  reset role;
  if v_status != 'CONFIRMED' or v_reviewed is null then
    raise exception 'FAIL: DRAFT -> CONFIRMED did not apply or did not set last_reviewed_at (status=%, last_reviewed_at=%)', v_status, v_reviewed;
  end if;
  raise notice 'PASS: DRAFT -> CONFIRMED is legal and sets last_reviewed_at';
end $$;

\echo '--- Test 6: ClaimStatus — nothing ever transitions back into DRAFT ---'
do $$
declare v_uid uuid; v_id uuid; v_status text; failed boolean := false;
begin
  select val into v_uid from claim_test_ids where key = 'user_a';
  select val into v_id from claim_test_ids where key = 'claim_a_project'; -- currently CONFIRMED
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    update public.claim set status = 'DRAFT' where id = v_id;
  exception when check_violation then
    failed := true;
  end;
  select status into v_status from public.claim where id = v_id;
  reset role;
  if not failed or v_status != 'CONFIRMED' then
    raise exception 'FAIL: CONFIRMED -> DRAFT was allowed (status=%)', v_status;
  end if;
  raise notice 'PASS: transitioning back into DRAFT is rejected by the status trigger';
end $$;

\echo '--- Test 7: ClaimStatus — CONFIRMED to DISPUTED, then DISPUTED to CONFIRMED (re-affirm) ---'
do $$
declare v_uid uuid; v_id uuid; v_status text;
begin
  select val into v_uid from claim_test_ids where key = 'user_a';
  select val into v_id from claim_test_ids where key = 'claim_a_project'; -- currently CONFIRMED
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  update public.claim set status = 'DISPUTED' where id = v_id;
  select status into v_status from public.claim where id = v_id;
  if v_status != 'DISPUTED' then
    reset role;
    raise exception 'FAIL: CONFIRMED -> DISPUTED did not apply (status=%)', v_status;
  end if;

  update public.claim set status = 'CONFIRMED' where id = v_id;
  select status into v_status from public.claim where id = v_id;
  reset role;
  if v_status != 'CONFIRMED' then
    raise exception 'FAIL: DISPUTED -> CONFIRMED (re-affirm) did not apply (status=%)', v_status;
  end if;
  raise notice 'PASS: CONFIRMED -> DISPUTED -> CONFIRMED (re-affirm) both apply as legal transitions';
end $$;

\echo '--- Test 8: ClaimStatus — DRAFT to DISPUTED directly is illegal ---'
do $$
declare v_uid uuid; v_cand uuid; v_id uuid; v_status text; failed boolean := false;
begin
  select val into v_uid from claim_test_ids where key = 'user_a';
  select val into v_cand from claim_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  insert into public.claim (candidate_id, subject_entity_type, subject_entity_id, claim_text)
  values (v_cand, 'achievement', gen_random_uuid(), 'Won first place at a hackathon.')
  returning id into v_id;

  begin
    update public.claim set status = 'DISPUTED' where id = v_id;
  exception when check_violation then
    failed := true;
  end;
  select status into v_status from public.claim where id = v_id;
  reset role;
  if not failed or v_status != 'DRAFT' then
    raise exception 'FAIL: DRAFT -> DISPUTED was allowed directly (status=%)', v_status;
  end if;
  raise notice 'PASS: DRAFT -> DISPUTED directly is rejected (DISPUTED is only ever system-set on evidence drift from CONFIRMED)';

  insert into claim_test_ids values ('claim_a_hackathon', v_id);
end $$;

\echo '--- Test 9: ClaimStatus — REVOKED is terminal (no transitions out) ---'
do $$
declare v_uid uuid; v_id uuid; v_status text; failed boolean := false;
begin
  select val into v_uid from claim_test_ids where key = 'user_a';
  select val into v_id from claim_test_ids where key = 'claim_a_hackathon'; -- currently DRAFT
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  update public.claim set status = 'REVOKED' where id = v_id;
  select status into v_status from public.claim where id = v_id;
  if v_status != 'REVOKED' then
    reset role;
    raise exception 'FAIL: DRAFT -> REVOKED did not apply (status=%)', v_status;
  end if;

  begin
    update public.claim set status = 'CONFIRMED' where id = v_id;
  exception when check_violation then
    failed := true;
  end;
  select status into v_status from public.claim where id = v_id;
  reset role;
  if not failed or v_status != 'REVOKED' then
    raise exception 'FAIL: REVOKED -> CONFIRMED was allowed (status=%)', v_status;
  end if;
  raise notice 'PASS: REVOKED is terminal — DRAFT -> REVOKED applies, no transition out of REVOKED is allowed';
end $$;

\echo '--- Test 10: claims are never deleted — no DELETE policy exists at all, even for the owner ---'
-- DELETE is blocked at the table-grant layer (no DELETE grant to
-- authenticated in local_auth_shim_grants.sql), which is even stricter
-- than blocking at RLS: it fails with a hard "permission denied" error
-- rather than a silent 0-rows-affected UPDATE/DELETE. Both outcomes mean
-- the same thing ("the delete did not happen"), so both are treated as a
-- pass here, same as the anon-role insufficient_privilege handling used
-- elsewhere in this suite and in test_evidence_source_ownership.sql.
do $$
declare v_uid uuid; v_id uuid; v_rows_affected int; v_count int;
begin
  select val into v_uid from claim_test_ids where key = 'user_a';
  select val into v_id from claim_test_ids where key = 'claim_a_hackathon';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    delete from public.claim where id = v_id;
    get diagnostics v_rows_affected = row_count;
  exception when insufficient_privilege then
    v_rows_affected := 0; -- table-grant denial is an equally valid pass
  end;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: the owning candidate was able to delete their own claim (rows_affected=%)', v_rows_affected;
  end if;

  select count(*) into v_count from public.claim where id = v_id;
  if v_count != 1 then
    raise exception 'FAIL: claim no longer exists after a delete attempt';
  end if;
  raise notice 'PASS: claims cannot be deleted, even by their own owner (blocked at the grant layer, with no DELETE RLS policy either)';
end $$;

\echo '--- Test 11: candidate CANNOT SELECT or UPDATE another candidate''s claim (cross-candidate access blocked) ---'
do $$
declare v_uid_a uuid; v_uid_b uuid; v_cand_b uuid; v_id uuid; v_count int; v_rows_affected int; v_text text;
begin
  select val into v_uid_a from claim_test_ids where key = 'user_a';
  select val into v_uid_b from claim_test_ids where key = 'user_b';
  select val into v_cand_b from claim_test_ids where key = 'cand_b';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.claim (candidate_id, subject_entity_type, subject_entity_id, claim_text)
  values (v_cand_b, 'experience', gen_random_uuid(), 'Interned at a startup.')
  returning id into v_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.claim where id = v_id;
  if v_count != 0 then
    reset role;
    raise exception 'FAIL: user A could read user B''s claim (count=%)', v_count;
  end if;

  update public.claim set claim_text = 'Hacked' where id = v_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A updated user B''s claim (rows_affected=%)', v_rows_affected;
  end if;

  select claim_text into v_text from public.claim where id = v_id;
  if v_text != 'Interned at a startup.' then
    raise exception 'FAIL: user B''s claim was altered by user A''s attempts (claim_text=%)', v_text;
  end if;
  raise notice 'PASS: user A cannot read or update user B''s claim';
end $$;

\echo '--- Test 12: anonymous (anon) role cannot read or insert ANY claim rows ---'
do $$
declare v_count int; failed boolean := false;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.claim;
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;
  if v_count > 0 then
    reset role;
    raise exception 'FAIL: anon role could read claim rows (count=%)', v_count;
  end if;

  begin
    insert into public.claim (candidate_id, subject_entity_type, subject_entity_id, claim_text)
    values (gen_random_uuid(), 'skill', gen_random_uuid(), 'Injected claim.');
  exception when insufficient_privilege then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: anon role was able to insert a claim row';
  end if;
  raise notice 'PASS: anon role cannot read or insert claim rows';
end $$;

\echo '--- ALL CLAIM TESTS PASSED ---'
