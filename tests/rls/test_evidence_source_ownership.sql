-- test_evidence_source_ownership.sql
-- Day 3 test suite: EvidenceSource entity — valid creation for both source
-- types, multiple evidence sources per candidate, validation failures
-- (including the ref-matches-type constraint), own-row read/update/delete,
-- cross-candidate access, and anonymous access.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- any other test suite.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (EvidenceSource suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'evidence-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'evidence-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table ev_test_ids (key text primary key, val uuid);
  insert into ev_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                  ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT a valid document_upload evidence source ---'
do $$
declare v_uid uuid; v_cand uuid; v_id uuid; v_count int;
begin
  select val into v_uid from ev_test_ids where key = 'user_a';
  select val into v_cand from ev_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.evidence_source (candidate_id, source_type, title, file_ref)
  values (v_cand, 'document_upload', 'Resume.pdf', 'uploads/cand-a/resume.pdf')
  returning id into v_id;
  reset role;

  select count(*) into v_count from public.evidence_source
    where id = v_id and candidate_id = v_cand and owner_verified = false;
  if v_count != 1 then
    raise exception 'FAIL: valid document_upload evidence source did not persist (owner_verified should default false)';
  end if;
  raise notice 'PASS: candidate can insert a valid document_upload evidence source, owner_verified defaults to false';

  insert into ev_test_ids values ('evidence_a_resume', v_id);
end $$;

\echo '--- Test 2: candidate can INSERT a valid github_repository evidence source ---'
do $$
declare v_uid uuid; v_cand uuid; v_id uuid; v_count int;
begin
  select val into v_uid from ev_test_ids where key = 'user_a';
  select val into v_cand from ev_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into public.evidence_source (candidate_id, source_type, title, external_url)
  values (v_cand, 'github_repository', 'InternshipOS', 'https://github.com/example/internshipos')
  returning id into v_id;
  reset role;

  select count(*) into v_count from public.evidence_source where id = v_id and candidate_id = v_cand;
  if v_count != 1 then
    raise exception 'FAIL: valid github_repository evidence source did not persist';
  end if;
  raise notice 'PASS: candidate can insert a valid github_repository evidence source';
end $$;

\echo '--- Test 3: candidate supports MULTIPLE evidence sources (not just one) ---'
do $$
declare v_cand uuid; v_count int;
begin
  select val into v_cand from ev_test_ids where key = 'cand_a';
  select count(*) into v_count from public.evidence_source where candidate_id = v_cand;
  if v_count < 2 then
    raise exception 'FAIL: candidate could not hold multiple evidence sources (count=%)', v_count;
  end if;
  raise notice 'PASS: candidate can hold multiple evidence sources (count=%)', v_count;
end $$;

\echo '--- Test 4: validation failure — empty title is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from ev_test_ids where key = 'user_a';
  select val into v_cand from ev_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.evidence_source (candidate_id, source_type, title, file_ref)
    values (v_cand, 'document_upload', '   ', 'uploads/x.pdf');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an empty/whitespace-only title was accepted by the DB';
  end if;
  raise notice 'PASS: empty/whitespace-only title is rejected by the DB check constraint';
end $$;

\echo '--- Test 5: validation failure — invalid source_type is rejected at the DB layer ---'
do $$
declare v_uid uuid; v_cand uuid; failed boolean := false;
begin
  select val into v_uid from ev_test_ids where key = 'user_a';
  select val into v_cand from ev_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into public.evidence_source (candidate_id, source_type, title, external_url)
    values (v_cand, 'linkedin_profile', 'LinkedIn', 'https://linkedin.com/in/example');
  exception when check_violation then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: an invalid source_type enum value was accepted by the DB';
  end if;
  raise notice 'PASS: invalid source_type enum value is rejected by the DB check constraint';
end $$;

\echo '--- Test 6: validation failure — file_ref/external_url must match source_type ---'
do $$
declare v_uid uuid; v_cand uuid; failed_mismatch1 boolean := false; failed_mismatch2 boolean := false;
begin
  select val into v_uid from ev_test_ids where key = 'user_a';
  select val into v_cand from ev_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  begin
    -- document_upload with external_url instead of file_ref
    insert into public.evidence_source (candidate_id, source_type, title, external_url)
    values (v_cand, 'document_upload', 'Bad Doc', 'https://example.com/resume.pdf');
  exception when check_violation then
    failed_mismatch1 := true;
  end;

  begin
    -- github_repository with file_ref instead of external_url
    insert into public.evidence_source (candidate_id, source_type, title, file_ref)
    values (v_cand, 'github_repository', 'Bad Repo', 'uploads/not-a-repo.txt');
  exception when check_violation then
    failed_mismatch2 := true;
  end;

  reset role;
  if not failed_mismatch1 or not failed_mismatch2 then
    raise exception 'FAIL: evidence_source_ref_matches_type did not reject a source_type/ref mismatch';
  end if;
  raise notice 'PASS: file_ref/external_url must match source_type (evidence_source_ref_matches_type enforced)';
end $$;

\echo '--- Test 7: candidate can SELECT/UPDATE/DELETE their own evidence source (own-row access) ---'
do $$
declare v_uid uuid; v_id uuid; v_title text; v_count int;
begin
  select val into v_uid from ev_test_ids where key = 'user_a';
  select val into v_id from ev_test_ids where key = 'evidence_a_resume';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  select count(*) into v_count from public.evidence_source where id = v_id;
  update public.evidence_source set title = 'Updated Resume.pdf' where id = v_id;
  select title into v_title from public.evidence_source where id = v_id;
  reset role;

  if v_count != 1 or v_title != 'Updated Resume.pdf' then
    raise exception 'FAIL: user A could not select/update their own evidence source';
  end if;
  raise notice 'PASS: user A can select and update their own evidence source';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  delete from public.evidence_source where id = v_id;
  reset role;

  select count(*) into v_count from public.evidence_source where id = v_id;
  if v_count != 0 then
    raise exception 'FAIL: user A could not delete their own evidence source';
  end if;
  raise notice 'PASS: user A can delete their own evidence source';
end $$;

\echo '--- Test 8: candidate CANNOT SELECT another candidate''s evidence source (cross-candidate access blocked) ---'
do $$
declare v_uid_a uuid; v_uid_b uuid; v_cand_b uuid; v_id uuid; v_count int;
begin
  select val into v_uid_a from ev_test_ids where key = 'user_a';
  select val into v_uid_b from ev_test_ids where key = 'user_b';
  select val into v_cand_b from ev_test_ids where key = 'cand_b';

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into public.evidence_source (candidate_id, source_type, title, file_ref)
  values (v_cand_b, 'document_upload', 'Bob Transcript', 'uploads/cand-b/transcript.pdf')
  returning id into v_id;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from public.evidence_source where id = v_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: user A could read user B''s evidence source (count=%)', v_count;
  end if;
  raise notice 'PASS: user A cannot read user B''s evidence source';

  insert into ev_test_ids values ('evidence_b_transcript', v_id);
end $$;

\echo '--- Test 9: candidate CANNOT UPDATE or DELETE another candidate''s evidence source ---'
do $$
declare v_uid_a uuid; v_id uuid; v_rows_affected int; v_title text;
begin
  select val into v_uid_a from ev_test_ids where key = 'user_a';
  select val into v_id from ev_test_ids where key = 'evidence_b_transcript';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;

  update public.evidence_source set title = 'Hacked' where id = v_id;
  get diagnostics v_rows_affected = row_count;
  if v_rows_affected != 0 then
    reset role;
    raise exception 'FAIL: user A updated user B''s evidence source (rows_affected=%)', v_rows_affected;
  end if;

  delete from public.evidence_source where id = v_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: user A deleted user B''s evidence source (rows_affected=%)', v_rows_affected;
  end if;

  select title into v_title from public.evidence_source where id = v_id;
  if v_title != 'Bob Transcript' then
    raise exception 'FAIL: user B''s evidence source was altered by user A''s attempts (title=%)', v_title;
  end if;
  raise notice 'PASS: user A cannot update or delete user B''s evidence source';
end $$;

\echo '--- Test 10: anonymous (anon) role cannot read or insert ANY evidence_source rows ---'
do $$
declare v_count int; failed boolean := false;
begin
  set local role anon;
  begin
    select count(*) into v_count from public.evidence_source;
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;
  if v_count > 0 then
    reset role;
    raise exception 'FAIL: anon role could read evidence_source rows (count=%)', v_count;
  end if;

  begin
    insert into public.evidence_source (candidate_id, source_type, title, file_ref)
    values (gen_random_uuid(), 'document_upload', 'Injected', 'uploads/x.pdf');
  exception when insufficient_privilege then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: anon role was able to insert an evidence_source row';
  end if;
  raise notice 'PASS: anon role cannot read or insert evidence_source rows';
end $$;

\echo '--- ALL EVIDENCE SOURCE TESTS PASSED ---'
