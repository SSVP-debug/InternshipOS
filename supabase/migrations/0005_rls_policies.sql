-- 0005_rls_policies.sql
-- Phase 0 / Day 1 — PII access boundary via Row-Level Security.
--
-- Design rule (per approved architecture, §6 Security boundaries):
-- a candidate can only ever read/write their OWN rows. There is no policy,
-- in any table below, that allows reading another candidate's data through
-- the regular (anon/authenticated) roles. The service_role key (used only by
-- trusted backend jobs, never exposed to a client) bypasses RLS by default
-- in Supabase and is the sole path for cross-candidate operations.

alter table public.candidate       enable row level security;
alter table public.personal_info   enable row level security;
alter table public.consent_record  enable row level security;

-- Belt-and-braces: force RLS even for the table owner role, so an
-- application bug that connects as the owner doesn't accidentally bypass it.
alter table public.candidate       force row level security;
alter table public.personal_info   force row level security;
alter table public.consent_record  force row level security;

-- ── candidate ────────────────────────────────────────────────────────────
-- A user may see/update only the candidate row whose auth_user_id matches
-- their own JWT subject. No delete policy in Day 1 (deletion is a Day 6
-- feature — a real cascading delete flow, not an ad-hoc client DELETE).

drop policy if exists candidate_select_own on public.candidate;
create policy candidate_select_own
  on public.candidate
  for select
  using (auth_user_id = auth.uid());

drop policy if exists candidate_insert_own on public.candidate;
create policy candidate_insert_own
  on public.candidate
  for insert
  with check (auth_user_id = auth.uid());

drop policy if exists candidate_update_own on public.candidate;
create policy candidate_update_own
  on public.candidate
  for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());

-- ── personal_info ────────────────────────────────────────────────────────
-- Ownership is via the parent candidate row, checked through a subquery
-- rather than duplicating auth_user_id onto this table — personal_info has
-- no direct notion of "owner," only "which candidate it belongs to."

drop policy if exists personal_info_select_own on public.personal_info;
create policy personal_info_select_own
  on public.personal_info
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = personal_info.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

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
  );

-- ── consent_record ───────────────────────────────────────────────────────
-- Same ownership-through-candidate pattern. Consent is candidate-inserted
-- and candidate-revoked (via update of revoked_at) — no client-side delete;
-- the ledger is append-mostly per the architecture doc.

drop policy if exists consent_select_own on public.consent_record;
create policy consent_select_own
  on public.consent_record
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = consent_record.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists consent_insert_own on public.consent_record;
create policy consent_insert_own
  on public.consent_record
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = consent_record.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists consent_update_own on public.consent_record;
create policy consent_update_own
  on public.consent_record
  -- update is restricted to revocation only, enforced at the API layer
  -- (candidates should not be able to rewrite granted_at/version history)
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = consent_record.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = consent_record.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
