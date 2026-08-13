-- 0008_work_authorization.sql
-- Phase 0 / Day 2 — WorkAuthorization entity only (Candidate-facts domain).
--
-- Per docs/candidate-truth-layer-phase0.md: WorkAuthorization is
-- current-state only in Phase 0 — a single row per candidate, not a
-- history table. WorkAuthorizationHistory is explicitly deferred (§3 /
-- §8 of the approved architecture) and is NOT created here.
--
-- Structurally this is a 1:1 entity, same shape as personal_info
-- (0003_personal_info.sql): candidate_id IS the primary key, not a
-- separate uuid id + fk. Mirrors that migration's conventions exactly.

create table if not exists public.work_authorization (
  candidate_id            uuid primary key references public.candidate(id) on delete cascade,
  citizenship_country     text not null,
  status                  text not null
                            check (status in (
                              'us_citizen',
                              'permanent_resident',
                              'f1_opt',
                              'f1_cpt',
                              'stem_opt_eligible',
                              'h1b',
                              'other_visa',
                              'needs_sponsorship',
                              'not_applicable_non_us'
                            )),
  -- Stored explicitly rather than derived from `status`, per the approved
  -- architecture and this task's requirements — e.g. an H1B holder may or
  -- may not need further sponsorship depending on individual circumstance,
  -- so this is never inferred from the enum value alone.
  requires_sponsorship    boolean not null,
  work_auth_expiry_date   date,
  -- Self-attested tier only (Candidate Truth Layer doc §3.1) — free text,
  -- not evidence-backed. Never promoted to a Claim without independent
  -- corroboration; out of scope for Phase 0 regardless.
  notes                   text,
  updated_at              timestamptz not null default now()
);

comment on table public.work_authorization is
  'Candidate-facts domain. Current-state only (single row per candidate) — '
  'WorkAuthorizationHistory is deferred past Phase 0.';

drop trigger if exists trg_work_authorization_updated_at on public.work_authorization;
create trigger trg_work_authorization_updated_at
  before update on public.work_authorization
  for each row
  execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Same ownership-through-candidate pattern as personal_info/consent_record.
-- No delete policy, matching personal_info's Day-1 precedent (this is
-- current-state identity data, not an ad-hoc record list like education) —
-- a candidate replacing their work authorization status does so via UPDATE,
-- not delete-then-recreate.

alter table public.work_authorization enable row level security;
alter table public.work_authorization force row level security;

drop policy if exists work_authorization_select_own on public.work_authorization;
create policy work_authorization_select_own
  on public.work_authorization
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = work_authorization.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists work_authorization_insert_own on public.work_authorization;
create policy work_authorization_insert_own
  on public.work_authorization
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = work_authorization.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists work_authorization_update_own on public.work_authorization;
create policy work_authorization_update_own
  on public.work_authorization
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = work_authorization.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = work_authorization.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
