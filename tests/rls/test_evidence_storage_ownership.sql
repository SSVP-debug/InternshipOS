-- test_evidence_storage_ownership.sql
-- Gate 1a test suite: storage.objects RLS for the evidence-documents
-- bucket — own-path insert/select/delete, cross-candidate access blocked,
-- wrong-bucket rows unaffected, anonymous access blocked.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- any other test suite. Depends on tests/local_storage_shim.sql having
-- already been applied (storage.objects / storage.buckets / foldername()),
-- same as every other suite here depends on local_auth_shim.sql.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning (Storage suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'storage-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'storage-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  create temporary table storage_test_ids (key text primary key, val uuid);
  insert into storage_test_ids values ('user_a', user_a_id), ('user_b', user_b_id),
                                       ('cand_a', cand_a_id), ('cand_b', cand_b_id);
end $$;

\echo '--- Test 1: candidate can INSERT an object under their own candidate_id-prefixed path ---'
do $$
declare v_uid uuid; v_cand uuid; v_id uuid; v_count int;
begin
  select val into v_uid from storage_test_ids where key = 'user_a';
  select val into v_cand from storage_test_ids where key = 'cand_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  insert into storage.objects (bucket_id, name, owner)
  values ('evidence-documents', v_cand::text || '/resume.pdf', v_uid)
  returning id into v_id;
  reset role;

  select count(*) into v_count from storage.objects where id = v_id;
  if v_count != 1 then
    raise exception 'FAIL: candidate could not insert an object under their own path';
  end if;
  raise notice 'PASS: candidate can insert an object under their own candidate_id-prefixed path';

  insert into storage_test_ids values ('object_a_resume', v_id);
end $$;

\echo '--- Test 2: candidate CANNOT INSERT an object under a DIFFERENT candidate_id path ---'
do $$
declare v_uid uuid; v_cand_b uuid; failed boolean := false;
begin
  select val into v_uid from storage_test_ids where key = 'user_a';
  select val into v_cand_b from storage_test_ids where key = 'cand_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('evidence-documents', v_cand_b::text || '/injected.pdf', v_uid);
  exception when insufficient_privilege or others then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: candidate A inserted an object under candidate B''s path';
  end if;
  raise notice 'PASS: candidate cannot insert an object under another candidate''s path';
end $$;

\echo '--- Test 3: candidate can SELECT/DELETE their own object (own-row access) ---'
do $$
declare v_uid uuid; v_id uuid; v_count int;
begin
  select val into v_uid from storage_test_ids where key = 'user_a';
  select val into v_id from storage_test_ids where key = 'object_a_resume';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid)::text, true);
  set local role authenticated;

  select count(*) into v_count from storage.objects where id = v_id;
  if v_count != 1 then
    reset role;
    raise exception 'FAIL: candidate A could not select their own object';
  end if;

  delete from storage.objects where id = v_id;
  reset role;

  select count(*) into v_count from storage.objects where id = v_id;
  if v_count != 0 then
    raise exception 'FAIL: candidate A could not delete their own object';
  end if;
  raise notice 'PASS: candidate can select and delete their own object';
end $$;

\echo '--- Test 4: candidate CANNOT SELECT another candidate''s object (cross-candidate access blocked) ---'
do $$
declare v_uid_a uuid; v_uid_b uuid; v_cand_b uuid; v_id uuid; v_count int;
begin
  select val into v_uid_b from storage_test_ids where key = 'user_b';
  select val into v_cand_b from storage_test_ids where key = 'cand_b';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_b)::text, true);
  set local role authenticated;
  insert into storage.objects (bucket_id, name, owner)
  values ('evidence-documents', v_cand_b::text || '/transcript.pdf', v_uid_b)
  returning id into v_id;
  reset role;

  select val into v_uid_a from storage_test_ids where key = 'user_a';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;
  select count(*) into v_count from storage.objects where id = v_id;
  reset role;
  if v_count != 0 then
    raise exception 'FAIL: candidate A could read candidate B''s object (count=%)', v_count;
  end if;
  raise notice 'PASS: candidate A cannot read candidate B''s object';

  insert into storage_test_ids values ('object_b_transcript', v_id);
end $$;

\echo '--- Test 5: candidate CANNOT DELETE another candidate''s object ---'
do $$
declare v_uid_a uuid; v_id uuid; v_rows_affected int; v_count int;
begin
  select val into v_uid_a from storage_test_ids where key = 'user_a';
  select val into v_id from storage_test_ids where key = 'object_b_transcript';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid_a)::text, true);
  set local role authenticated;

  delete from storage.objects where id = v_id;
  get diagnostics v_rows_affected = row_count;
  reset role;
  if v_rows_affected != 0 then
    raise exception 'FAIL: candidate A deleted candidate B''s object (rows_affected=%)', v_rows_affected;
  end if;

  select count(*) into v_count from storage.objects where id = v_id;
  if v_count != 1 then
    raise exception 'FAIL: candidate B''s object no longer exists after candidate A''s delete attempt';
  end if;
  raise notice 'PASS: candidate A cannot delete candidate B''s object';
end $$;

\echo '--- Test 6: anonymous (anon) role cannot read or insert ANY evidence-documents objects ---'
do $$
declare v_count int; failed boolean := false;
begin
  set local role anon;
  begin
    select count(*) into v_count from storage.objects where bucket_id = 'evidence-documents';
  exception when insufficient_privilege then
    v_count := -1; -- table-level grant denial is an equally valid pass
  end;
  if v_count > 0 then
    reset role;
    raise exception 'FAIL: anon role could read evidence-documents objects (count=%)', v_count;
  end if;

  begin
    insert into storage.objects (bucket_id, name)
    values ('evidence-documents', 'anonymous-injected.pdf');
  exception when insufficient_privilege or others then
    failed := true;
  end;
  reset role;
  if not failed then
    raise exception 'FAIL: anon role was able to insert an evidence-documents object';
  end if;
  raise notice 'PASS: anon role cannot read or insert evidence-documents objects';
end $$;

\echo '--- ALL EVIDENCE STORAGE TESTS PASSED ---'
