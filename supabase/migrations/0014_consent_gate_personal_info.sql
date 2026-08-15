-- 0014_consent_gate_personal_info.sql
-- Phase 0 — Consent gate for the PII write path.
--
-- Audit finding (read-only security audit, Phase 0): the `data_processing`
-- consent gate was completely absent. `handle_new_auth_user()` (0006)
-- unconditionally provisions a `candidate` row with no consent check, and
-- POST /profile (api/src/routes/profile.ts) never queried consent_record
-- before writing personal_info. Audit result: FAIL.
--
-- Why the gate sits on personal_info, not on candidate creation:
-- consent_record.candidate_id references candidate.id, so a consent row
-- cannot exist before its candidate row does — pre-candidate consent
-- capture is structurally impossible without a schema change we are not
-- making here. The architecture doc (§4 Privacy architecture) separates
-- bare candidate identity (no PII) from personal_info (where PII lives):
-- candidate creation stays consent-free by design, and the gate is placed
-- at the first point PII is actually written, which is personal_info.
--
-- This migration replaces the personal_info INSERT/UPDATE RLS policies
-- from 0005_rls_policies.sql, adding a requirement that the owning
-- candidate have an active (unrevoked) data_processing consent_record.
-- SELECT is intentionally left unchanged — a candidate who later revokes
-- consent can still read their own already-stored data; revocation blocks
-- further writes, it does not retroactively hide existing rows.
--
-- This is the database-level (authoritative) half of the consent gate.
-- api/src/middleware/requireConsent.ts is the API-level half (defense in
-- depth) and is applied only to POST /profile.

drop policy if exists personal_info_insert_own on public.personal_info;
create policy personal_info_insert_own
  on public.personal_info
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = personal_info.candidate_id
        and c.auth_user_id = auth.uid()
    )
    and exists (
      select 1 from public.consent_record cr
      where cr.candidate_id = personal_info.candidate_id
        and cr.consent_type = 'data_processing'
        and cr.revoked_at is null
    )
  );

drop policy if exists personal_info_update_own on public.personal_info;
create policy personal_info_update_own
  on public.personal_info
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = personal_info.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = personal_info.candidate_id
        and c.auth_user_id = auth.uid()
    )
    and exists (
      select 1 from public.consent_record cr
      where cr.candidate_id = personal_info.candidate_id
        and cr.consent_type = 'data_processing'
        and cr.revoked_at is null
    )
  );

-- personal_info_select_own (0005) is unchanged — read access does not
-- require active consent, only writes do.
