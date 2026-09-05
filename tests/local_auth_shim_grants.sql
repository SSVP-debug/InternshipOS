-- local_auth_shim_grants.sql
-- LOCAL TEST HARNESS ONLY — run after supabase/migrations/*.sql.
-- Mirrors the table-grant defaults Supabase already configures on a real
-- project. RLS policies (0005_rls_policies.sql) do the actual row-level
-- restriction; these are the coarser table-level grants beneath them.

grant select, insert, update on public.candidate, public.personal_info, public.consent_record
  to authenticated;

-- Day 2: Education entity grants (same pattern as Day 1 tables above).
grant select, insert, update, delete on public.education to authenticated;

-- Day 2: WorkAuthorization entity grants (1:1, same pattern as personal_info —
-- no delete grant, matching the precedent set there).
grant select, insert, update on public.work_authorization to authenticated;

-- Day 2: Skill entity grants (multi-row, same pattern as education).
grant select, insert, update, delete on public.skill to authenticated;

-- Day 2: Project entity grants (multi-row, same pattern as education/skill).
grant select, insert, update, delete on public.project to authenticated;

-- Day 2: Experience entity grants (multi-row, same pattern as project).
grant select, insert, update, delete on public.experience to authenticated;

-- Day 2: Achievement entity grants (multi-row, same pattern as experience).
grant select, insert, update, delete on public.achievement to authenticated;

-- Day 2: Certification entity grants (multi-row, same pattern as achievement).
grant select, insert, update, delete on public.certification to authenticated;

-- Day 3: EvidenceSource entity grants (multi-row, same pattern as skill/project).
grant select, insert, update, delete on public.evidence_source to authenticated;

-- Day 4: Claim entity grants. No delete grant — claims are never deleted
-- (0016_claim.sql has no DELETE RLS policy either; this grant is the
-- coarser table-level half of that same "claims are permanent" rule).
grant select, insert, update on public.claim to authenticated;

-- Phase 1: Opportunity entity grants (multi-row, candidate-owned, same
-- pattern as education/skill/project).
grant select, insert, update, delete on public.opportunity to authenticated;

-- Phase 1: Application entity grants. Delete IS granted here (unlike
-- claim) — see 0018_application.sql's header for why the DB still allows
-- it even though the API layer doesn't currently expose a DELETE route.
grant select, insert, update, delete on public.application to authenticated;

-- Phase 1: Application status history grants. No update/delete grant —
-- immutable history, same "claims are permanent" treatment as public.claim.
grant select, insert on public.application_status_event to authenticated;

-- Phase 1: Application notes grants (multi-row, editable, lightweight).
grant select, insert, update, delete on public.application_note to authenticated;

-- Phase 1A/2A: Opportunity Intelligence grants (0022_opportunity_intelligence_foundation.sql).
--
-- opportunity_source: authenticated gets SELECT only — matches the RLS
-- policy exactly (opportunity_source_select_active is a SELECT-only
-- policy; there is deliberately no INSERT/UPDATE/DELETE policy for
-- authenticated on this table, since only service-role ingestion ever
-- writes to it). Granting insert/update/delete here would be misleading
-- even though RLS would still block it (FORCE ROW LEVEL SECURITY with no
-- matching policy denies by default) — the grant should describe the same
-- surface the policy describes, not rely on RLS alone to hide an
-- unintended grant.
grant select on public.opportunity_source to authenticated;

-- opportunity_match: candidate-owned, same full CRUD grant pattern as
-- every other candidate-owned multi-row table (opportunity, education,
-- skill, ...) — RLS's ownership-through-candidate policies do the actual
-- per-row restriction.
grant select, insert, update, delete on public.opportunity_match to authenticated;

-- Gate 1a: evidence-documents Storage bucket grants (0021_evidence_storage_bucket.sql).
--
-- On a real Supabase project, storage.buckets/storage.objects already carry
-- these grants for anon/authenticated/service_role out of the box — this
-- local shim has to add them explicitly, same reasoning as
-- local_storage_shim.sql's own schema-usage grants. Missing this meant every
-- RLS test doing an authenticated-role write to storage.objects failed with
-- "permission denied for table objects" before RLS was ever consulted.
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;
grant all on storage.objects, storage.buckets to service_role;

-- Gate R1: resume, resume_skill grants (0025_resume.sql). Same full CRUD
-- grant pattern as every other candidate-owned multi-row table — RLS's
-- ownership-through-candidate/resume policies do the actual per-row
-- restriction.
grant select, insert, update, delete on public.resume, public.resume_skill to authenticated;

-- anon gets nothing in Phase 0/1/2 — no unauthenticated read/write surface yet.

-- service_role bypasses RLS via the bypassrls role attribute (set in
-- local_auth_shim.sql) and is the only role permitted to act across
-- candidates — used exclusively by trusted backend code (e.g. the signup
-- endpoint's post-provisioning step, and the ingestion/matching scripts'
-- writes to opportunity_source/opportunity_match), never exposed to a
-- client.
grant all on public.candidate, public.personal_info, public.consent_record, public.education, public.work_authorization, public.skill, public.project, public.experience, public.achievement, public.certification, public.evidence_source, public.claim, public.opportunity, public.application, public.application_status_event, public.application_note, public.opportunity_source, public.opportunity_match, public.resume, public.resume_skill
  to service_role;
