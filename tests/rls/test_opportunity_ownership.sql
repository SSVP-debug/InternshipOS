-- test_opportunity_ownership.sql
-- Phase 1 test suite: Opportunity entity — valid creation, defaults,
-- multiple opportunities per candidate, ownership, cross-candidate access,
-- and anonymous access.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- any other test suite.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (Opportunity suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'opp-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'opp-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table opp_test_ids (key text primary key, val uuid);
  insert into opp_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                   ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid opportunity (defaults: inbox_status=new, is_priority=false, employment_type=internship) ---'
do $$
declare v_uid uuid; v_cand uuid; v_id uuid; v_inbox_status text; v_priority boolean; v_emp_type text;
begin
  select val into v_uid from opp_test_ids where key = 'user_a';
  select val into v_cand from opp_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.opportunity (candidate_id, title, company, application_url)
  values (v_cand, 'Software Engineering Intern', 'Acme Corp', 'https://acme.example/careers/123')
  returning id into v_id;
  select inbox_status, is_priority, employment_type into v_inbox_status, v_priority, v_emp_type
    from public.opportunity where id = v_id;
  reset role;

  if v_inbox_status != 'new' or v_priority != false or v_emp_type != 'internship' then
    raise exception 'FAIL: opportunity did not apply expected defaults (inbox_status=%, is_priority=%, employment_type=%)',
      v_inbox_status, v_priority, v_emp_type;
  end if;
  raise notice 'PASS: candidate can insert a valid opportunity with expected defaults';

  insert into opp_test_ids values ('opp_a1', v_id);
end $$;

\echo '--- Test 2: blank title is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from opp_test_ids where key = 'user_a';
  select val into v_cand from opp_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.opportunity (candidate_id, title, company) values (v_cand, '   ', 'Acme Corp');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: a blank title was accepted by the DB';
  end if;
  raise notice 'PASS: blank title is rejected';
end $$;

\echo '--- Test 3: invalid work_mode is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from opp_test_ids where key = 'user_a';
  select val into v_cand from opp_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.opportunity (candidate_id, title, company, work_mode)
    values (v_cand, 'Data Intern', 'Beta Inc', 'from_space');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an invalid work_mode was accepted by the DB';
  end if;
  raise notice 'PASS: invalid work_mode is rejected';
end $$;

\echo '--- Test 4: candidate can update inbox_status (save) and is_priority ---'
do $$
declare v_uid uuid; v_opp_id uuid; v_inbox_status text; v_priority boolean;
begin
  select val into v_uid from opp_test_ids where key = 'user_a';
  select val into v_opp_id from opp_test_ids where key = 'opp_a1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  update public.opportunity set inbox_status = 'saved', is_priority = true where id = v_opp_id;
  select inbox_status, is_priority into v_inbox_status, v_priority from public.opportunity where id = v_opp_id;
  reset role;
  if v_inbox_status != 'saved' or v_priority != true then
    raise exception 'FAIL: opportunity save/priority update did not persist';
  end if;
  raise notice 'PASS: candidate can save and prioritize their own opportunity';
end $$;

\echo '--- Test 5: candidate supports MULTIPLE opportunities (not just one) ---'
do $$
declare v_uid uuid; v_cand uuid; v_count int;
begin
  select val into v_uid from opp_test_ids where key = 'user_a';
  select val into v_cand from opp_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.opportunity (candidate_id, title, company) values (v_cand, 'Product Intern', 'Gamma LLC');
  select count(*) into v_count from public.opportunity where candidate_id = v_cand;
  reset role;
  if v_count < 2 then
    raise exception 'FAIL: candidate could not hold multiple opportunities (count=%)', v_count;
  end if;
  raise notice 'PASS: candidate can hold multiple opportunities (count=%)', v_count;
end $$;

\echo '--- Test 6: candidate CANNOT SELECT another candidate''s opportunity (cross-candidate access blocked) ---'
do $$
declare v_uid_b uuid; v_cand_b uuid; v_uid_a uuid; v_opp_b_id uuid; v_count int;
begin
  select val into v_uid_b from opp_test_ids where key = 'user_b';
  select val into v_cand_b from opp_test_ids where key = 'cand_b';
  select val into v_uid_a from opp_test_ids where key = 'user_a';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.opportunity (candidate_id, title, company)
  values (v_cand_b, 'Bob''s Private Lead', 'Delta Co') returning id into v_opp_b_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.opportunity where id = v_opp_b_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s opportunity (count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot read user B''s opportunity';

  insert into opp_test_ids values ('opp_b1', v_opp_b_id);
end $$;

\echo '--- Test 7: candidate CANNOT UPDATE or DELETE another candidate''s opportunity ---'
do $$
declare v_uid_a uuid; v_opp_b_id uuid; v_rows_affected int; v_count int;
begin
  select val into v_uid_a from opp_test_ids where key = 'user_a';
  select val into v_opp_b_id from opp_test_ids where key = 'opp_b1';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;

  update public.opportunity set is_priority = true where id = v_opp_b_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A updated user B''s opportunity (rows_affected=%)', v_rows_affected;
  end if;

  delete from public.opportunity where id = v_opp_b_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s opportunity (rows_affected=%)', v_rows_affected;
  end if;

  select count(*) into v_count from public.opportunity where id = v_opp_b_id;
  if v_count != 1 then
    raise exception 'FAIL: user B''s opportunity no longer exists after user A''s tampering attempts';
  end if;
  raise notice 'PASS: user A cannot update or delete user B''s opportunity';
end $$;

\echo '--- Test 8: anon role cannot read ANY opportunity rows ---'
do $$
declare v_count int;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.opportunity;
  exception when insufficient_privilege then
    v_count := -1;
  end;
  reset role;
  if v_count > 0 then
    raise exception 'FAIL: anon role could read opportunity rows (count=%)', v_count;
  end if;
  raise notice 'PASS: anon role reads zero opportunity rows (denied at grant or RLS layer)';
end $$;

\echo '--- ALL OPPORTUNITY TESTS PASSED ---'
