-- test_account_deletion_cascade.sql
-- Day 5 test suite: verifies the referential-integrity chain that
-- DELETE /account (api/src/routes/account.ts) depends on — deleting the
-- auth.users row cascades through candidate.auth_user_id (0002) and then
-- through every domain table's candidate_id FK (all "on delete cascade")
-- to remove every trace of that candidate, across all 11 Phase-0 tables.
-- This is not an RLS test (the actual deletion happens via the
-- service_role admin API, which bypasses RLS entirely) — it's a
-- referential-integrity test confirming the cascade chain the API code
-- relies on actually works end-to-end in the deployed schema.
-- Run with: psql -v ON_ERROR_STOP=1 -f this_file
-- Self-contained (creates its own two users), does not depend on or modify
-- any other test suite.

\set ON_ERROR_STOP on
\echo '--- Setting up two auth.users + signup provisioning, with data across every Phase-0 table for user A (Deletion Cascade suite) ---'

do $$
declare
  user_a_id uuid := gen_random_uuid();
  user_b_id uuid := gen_random_uuid();
  cand_a_id uuid;
  cand_b_id uuid;
  evidence_a_id uuid;
begin
  insert into auth.users (id, email) values (user_a_id, 'cascade-alice@example.edu');
  insert into auth.users (id, email) values (user_b_id, 'cascade-bob@example.edu');

  select id into cand_a_id from public.candidate where auth_user_id = user_a_id;
  select id into cand_b_id from public.candidate where auth_user_id = user_b_id;

  if cand_a_id is null or cand_b_id is null then
    raise exception 'FAIL: signup trigger did not auto-provision a candidate row';
  end if;

  -- Populate every Phase-0 table for user A. Run as the table owner
  -- (superuser, whatever role this script connects as) rather than through
  -- RLS/authenticated — this suite is about the cascade mechanism, not
  -- ownership, so it doesn't need set_config/jwt.claims gymnastics.
  insert into public.consent_record (candidate_id, consent_type, version)
  values (cand_a_id, 'data_processing', 'v1.0');

  insert into public.personal_info (candidate_id, legal_first_name, legal_last_name, email, location_country)
  values (cand_a_id, 'Alice', 'Cascade', 'cascade-alice@example.edu', 'US');

  insert into public.education (candidate_id, institution_name, institution_country, degree_type, major, start_date, enrollment_status)
  values (cand_a_id, 'State University', 'US', 'bachelor', 'Computer Science', '2022-08-01', 'current');

  insert into public.work_authorization (candidate_id, citizenship_country, status, requires_sponsorship)
  values (cand_a_id, 'US', 'us_citizen', false);

  insert into public.skill (candidate_id, name, category)
  values (cand_a_id, 'TypeScript', 'language');

  insert into public.project (candidate_id, title, description)
  values (cand_a_id, 'InternshipOS', 'A candidate truth layer platform.');

  insert into public.experience (candidate_id, organization, title, employment_type, start_date, description_raw)
  values (cand_a_id, 'Acme Corp', 'Intern', 'internship', '2025-06-01', 'Worked on backend systems.');

  insert into public.achievement (candidate_id, title, date_awarded)
  values (cand_a_id, 'Hackathon Winner', '2025-03-01');

  insert into public.certification (candidate_id, name, issuer, issue_date)
  values (cand_a_id, 'AWS Certified', 'Amazon', '2025-01-01');

  insert into public.evidence_source (candidate_id, source_type, title, file_ref)
  values (cand_a_id, 'document_upload', 'Transcript.pdf', 'uploads/cand-a/transcript.pdf')
  returning id into evidence_a_id;

  insert into public.claim (candidate_id, subject_entity_type, subject_entity_id, claim_text, evidence_source_id)
  values (cand_a_id, 'project', gen_random_uuid(), 'Built InternshipOS end to end.', evidence_a_id);

  -- Minimal data for user B, to prove deletion is scoped to user A only.
  insert into public.skill (candidate_id, name, category)
  values (cand_b_id, 'Python', 'language');

  create temporary table cascade_test_ids (key text primary key, val uuid);
  insert into cascade_test_ids values
    ('user_a', user_a_id), ('user_b', user_b_id),
    ('cand_a', cand_a_id), ('cand_b', cand_b_id);

  raise notice 'PASS: user A has data seeded across all 11 Phase-0 tables, user B has one skill row';
end $$;

\echo '--- Test 1: every Phase-0 table has at least one row for user A before deletion (sanity check on the setup itself) ---'
do $$
declare v_cand uuid; v_missing text;
begin
  select val into v_cand from cascade_test_ids where key = 'cand_a';

  select tbl into v_missing from (
    select 'personal_info' as tbl where not exists (select 1 from public.personal_info where candidate_id = v_cand)
    union all select 'consent_record' where not exists (select 1 from public.consent_record where candidate_id = v_cand)
    union all select 'education' where not exists (select 1 from public.education where candidate_id = v_cand)
    union all select 'work_authorization' where not exists (select 1 from public.work_authorization where candidate_id = v_cand)
    union all select 'skill' where not exists (select 1 from public.skill where candidate_id = v_cand)
    union all select 'project' where not exists (select 1 from public.project where candidate_id = v_cand)
    union all select 'experience' where not exists (select 1 from public.experience where candidate_id = v_cand)
    union all select 'achievement' where not exists (select 1 from public.achievement where candidate_id = v_cand)
    union all select 'certification' where not exists (select 1 from public.certification where candidate_id = v_cand)
    union all select 'evidence_source' where not exists (select 1 from public.evidence_source where candidate_id = v_cand)
    union all select 'claim' where not exists (select 1 from public.claim where candidate_id = v_cand)
  ) missing
  limit 1;

  if v_missing is not null then
    raise exception 'FAIL: test setup did not actually seed the % table for user A', v_missing;
  end if;
  raise notice 'PASS: all 11 Phase-0 tables confirmed populated for user A prior to deletion';
end $$;

\echo '--- Test 2: deleting the auth.users row cascades through candidate to every domain table ---'
do $$
declare v_user_a uuid; v_cand uuid; v_remaining text; v_candidate_count int;
begin
  select val into v_user_a from cascade_test_ids where key = 'user_a';
  select val into v_cand from cascade_test_ids where key = 'cand_a';

  -- This is what DELETE /account triggers via the Auth admin API
  -- (supabase.auth.admin.deleteUser) in the real application; this test
  -- exercises the same underlying FK cascade directly against auth.users.
  delete from auth.users where id = v_user_a;

  select count(*) into v_candidate_count from public.candidate where id = v_cand;
  if v_candidate_count != 0 then
    raise exception 'FAIL: public.candidate row for user A still exists after auth.users deletion';
  end if;

  select tbl into v_remaining from (
    select 'personal_info' as tbl where exists (select 1 from public.personal_info where candidate_id = v_cand)
    union all select 'consent_record' where exists (select 1 from public.consent_record where candidate_id = v_cand)
    union all select 'education' where exists (select 1 from public.education where candidate_id = v_cand)
    union all select 'work_authorization' where exists (select 1 from public.work_authorization where candidate_id = v_cand)
    union all select 'skill' where exists (select 1 from public.skill where candidate_id = v_cand)
    union all select 'project' where exists (select 1 from public.project where candidate_id = v_cand)
    union all select 'experience' where exists (select 1 from public.experience where candidate_id = v_cand)
    union all select 'achievement' where exists (select 1 from public.achievement where candidate_id = v_cand)
    union all select 'certification' where exists (select 1 from public.certification where candidate_id = v_cand)
    union all select 'evidence_source' where exists (select 1 from public.evidence_source where candidate_id = v_cand)
    union all select 'claim' where exists (select 1 from public.claim where candidate_id = v_cand)
  ) remaining
  limit 1;

  if v_remaining is not null then
    raise exception 'FAIL: % still has a row for user A after auth.users deletion — cascade chain is broken', v_remaining;
  end if;
  raise notice 'PASS: deleting auth.users cascades through candidate to remove every row across all 11 Phase-0 tables';
end $$;

\echo '--- Test 3: deleting user A''s account did NOT affect user B''s data (deletion is scoped, not global) ---'
do $$
declare v_cand_b uuid; v_user_b uuid; v_skill_count int; v_candidate_count int;
begin
  select val into v_cand_b from cascade_test_ids where key = 'cand_b';
  select val into v_user_b from cascade_test_ids where key = 'user_b';

  select count(*) into v_candidate_count from public.candidate where id = v_cand_b;
  select count(*) into v_skill_count from public.skill where candidate_id = v_cand_b;

  if v_candidate_count != 1 or v_skill_count != 1 then
    raise exception 'FAIL: user B''s data was affected by user A''s account deletion (candidate_count=%, skill_count=%)', v_candidate_count, v_skill_count;
  end if;

  -- and user B's auth.users row itself must still be intact
  perform 1 from auth.users where id = v_user_b;
  if not found then
    raise exception 'FAIL: user B''s auth.users row was removed by user A''s account deletion';
  end if;

  raise notice 'PASS: user B''s account and data are completely untouched by user A''s deletion';
end $$;

\echo '--- ALL ACCOUNT DELETION CASCADE TESTS PASSED ---'
