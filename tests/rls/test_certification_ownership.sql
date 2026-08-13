-- test_certification_ownership.sql
-- Day 2 test suite: Certification entity — valid certification, multiple
-- certifications per candidate, required-field validation, optional-field
-- validation, invalid data rejection, own-row read/update/delete,
-- cross-candidate access blocked, and anonymous access blocked.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- the Day 1, Education, WorkAuthorization, Skill, Project, Experience, or
-- Achievement test suites.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (Certification suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'cert-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'cert-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table cert_test_ids (key text primary key, val uuid);
  insert into cert_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                    ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid certification ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int; v_id uuid;
begin
  select val into v_uid from cert_test_ids where key = 'user_a';
  select val into v_cand from cert_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.certification
    (candidate_id, name, issuer, issue_date, expiry_date, credential_id, verification_url)
  values
    (v_cand, 'AWS Certified Cloud Practitioner', 'Amazon Web Services', '2026-03-01',
     '2029-03-01', 'AWS-CCP-123456', 'https://aws.amazon.com/verification/123456')
  returning id into v_id;
  reset role;

  select count(*) into v_count from public.certification where id = v_id and candidate_id = v_cand;
  if v_count != 1 then
    raise exception 'FAIL: valid certification insert did not persist';
  end if;
  raise notice 'PASS: candidate can insert a valid certification';

  insert into cert_test_ids values ('cert_a_aws', v_id);
end $$;

\echo '--- Test 2: candidate supports MULTIPLE certifications (not just one) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from cert_test_ids where key = 'user_a';
  select val into v_cand from cert_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.certification (candidate_id, name, issuer, issue_date)
  values (v_cand, 'CompTIA A+', 'CompTIA', '2025-11-01');
  select count(*) into v_count from public.certification where candidate_id = v_cand;
  reset role;
  if v_count < 2 then
    raise exception 'FAIL: candidate could not hold multiple certifications (count=%)', v_count;
  end if;
  raise notice 'PASS: candidate can hold multiple certifications (count=%)', v_count;
end $$;

\echo '--- Test 3: required-field validation — empty name is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from cert_test_ids where key = 'user_a';
  select val into v_cand from cert_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.certification (candidate_id, name, issuer, issue_date)
    values (v_cand, '   ', 'Some Issuer', '2026-01-01');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an empty/whitespace-only certification name was accepted by the DB';
  end if;
  raise notice 'PASS: empty/whitespace-only certification name is rejected by the DB check constraint';
end $$;

\echo '--- Test 4: required-field validation — NULL issue_date is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from cert_test_ids where key = 'user_a';
  select val into v_cand from cert_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.certification (candidate_id, name, issuer, issue_date)
    values (v_cand, 'No Date Cert', 'Some Issuer', null);
  exception when not_null_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a NULL issue_date was accepted by the DB';
  end if;
  raise notice 'PASS: NULL issue_date is rejected (NOT NULL constraint)';
end $$;

\echo '--- Test 5: optional-field validation — expiry_date, credential_id, verification_url may all be omitted ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from cert_test_ids where key = 'user_a';
  select val into v_cand from cert_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.certification (candidate_id, name, issuer, issue_date)
  values (v_cand, 'Minimal Cert', 'Minimal Issuer', '2026-04-01');
  select count(*) into v_count from public.certification
    where candidate_id = v_cand and name = 'Minimal Cert'
      and expiry_date is null and credential_id is null and verification_url is null;
  reset role;
  if v_count != 1 then
    raise exception 'FAIL: a certification with all optional fields omitted did not persist correctly';
  end if;
  raise notice 'PASS: expiry_date, credential_id, and verification_url are all optional';
end $$;

\echo '--- Test 6: invalid data rejection — expiry_date before issue_date is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from cert_test_ids where key = 'user_a';
  select val into v_cand from cert_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.certification (candidate_id, name, issuer, issue_date, expiry_date)
    values (v_cand, 'Bad Timeline Cert', 'Some Issuer', '2026-03-01', '2020-01-01');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: expiry_date before issue_date was accepted by the DB';
  end if;
  raise notice 'PASS: expiry_date before issue_date is rejected (certification_expiry_after_issue)';
end $$;

\echo '--- Test 7: candidate can SELECT/UPDATE/DELETE their own certification (own-row access) ---'
do $$
declare v_uid uuid; v_cert_id uuid; v_credential text; v_count int;
begin
  select val into v_uid from cert_test_ids where key = 'user_a';
  select val into v_cert_id from cert_test_ids where key = 'cert_a_aws';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.certification where id = v_cert_id;
  update public.certification set credential_id = 'AWS-CCP-UPDATED' where id = v_cert_id;
  select credential_id into v_credential from public.certification where id = v_cert_id;
  reset role;

  if v_count != 1 or v_credential != 'AWS-CCP-UPDATED' then
    raise exception 'FAIL: user A could not select/update their own certification';
  end if;
  raise notice 'PASS: user A can select and update their own certification';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  delete from public.certification where id = v_cert_id;
  reset role;

  select count(*) into v_count from public.certification where id = v_cert_id;
  if v_count != 0 then
    raise exception 'FAIL: user A could not delete their own certification';
  end if;
  raise notice 'PASS: user A can delete their own certification';
end $$;

\echo '--- Test 8: candidate CANNOT SELECT/UPDATE/DELETE another candidate''s certification (cross-candidate access blocked) ---'
do $$
declare v_uid_b uuid; v_cand_b uuid; v_uid_a uuid; v_cert_b_id uuid; v_count int; v_rows_affected int; v_name text;
begin
  select val into v_uid_b from cert_test_ids where key = 'user_b';
  select val into v_cand_b from cert_test_ids where key = 'cand_b';
  select val into v_uid_a from cert_test_ids where key = 'user_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.certification (candidate_id, name, issuer, issue_date)
    values (v_cand_b, 'Bob''s Certification', 'Bob''s Issuer', '2026-02-01')
    returning id into v_cert_b_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.certification where id = v_cert_b_id;
  if v_count != 0 then
    reset role;
    raise exception 'FAIL: user A could read user B''s certification (count=%)', v_count;
  end if;

  update public.certification set name = 'Hacked' where id = v_cert_b_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected != 0 then
    reset role;
    raise exception 'FAIL: user A updated user B''s certification (rows_affected=%)', v_rows_affected;
  end if;

  delete from public.certification where id = v_cert_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s certification (rows_affected=%)', v_rows_affected;
  end if;

  select name into v_name from public.certification where id = v_cert_b_id;
  if v_name != 'Bob''s Certification' then
    raise exception 'FAIL: user B''s certification was altered by user A''s attempts (name=%)', v_name;
  end if;
  raise notice 'PASS: user A cannot read, update, or delete user B''s certification';
end $$;

\echo '--- Test 9: anonymous (anon) role cannot read or insert ANY certification rows ---'
do $$
declare v_count int; v_insert_failed boolean := false;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.certification;
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;

  begin
    insert into public.certification (candidate_id, name, issuer, issue_date)
      values (gen_random_uuid(), 'Anon Cert', 'Anon Issuer', '2026-01-01');
  exception when insufficient_privilege then
    v_insert_failed := true;
  end;
  reset role;

  if v_count > 0 then
    raise exception 'FAIL: anon role could read certification rows (count=%)', v_count;
  end if;
  if not v_insert_failed then
    raise exception 'FAIL: anon role was able to insert a certification row';
  end if;
  raise notice 'PASS: anon role cannot read or insert certification rows';
end $$;

\echo '--- ALL CERTIFICATION TESTS PASSED ---'
