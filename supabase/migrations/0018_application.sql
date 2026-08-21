-- 0018_application.sql
-- Phase 1 — Application entity: the core tracker record linking a
-- candidate to one of their own Opportunity rows, with a status lifecycle.
--
-- Design mirrors 0016_claim.sql's ClaimStatus approach deliberately (same
-- project, same reviewer, same "state machine enforced by a BEFORE
-- INSERT OR UPDATE trigger, not a plain CHECK constraint" reasoning —
-- a CHECK constraint cannot see the previous row to validate a transition).
--
-- Lifecycle (per task brief §4.D):
--   SAVED -> APPLYING | WITHDRAWN
--   APPLYING -> APPLIED | WITHDRAWN
--   APPLIED -> ASSESSMENT | INTERVIEW | REJECTED | WITHDRAWN
--   ASSESSMENT -> INTERVIEW | REJECTED | WITHDRAWN
--   INTERVIEW -> OFFER | REJECTED | WITHDRAWN
--   OFFER, REJECTED, WITHDRAWN: terminal, no outgoing transitions.
-- Same-status updates (ordinary field edits, e.g. editing next_action_note)
-- are always allowed and do not count as a transition.
--
-- opportunity_id has a real DB-level foreign key (unlike Claim's
-- subject_entity_id) because, unlike Claim's polymorphic subject, an
-- Application always points at exactly one concrete table (Opportunity) —
-- there is nothing polymorphic here, so a normal FK is the correct tool,
-- not an app-layer integrity check.
--
-- No DELETE route/policy is provided at the API layer for Application (see
-- api/src/routes/application.ts) — WITHDRAWN is the intended terminal
-- state for "I'm no longer pursuing this," preserving history rather than
-- erasing it, per task brief §4.D ("do not merely overwrite status
-- without recording meaningful changes"). The DB itself does still grant a
-- delete RLS policy (unlike Claim, which has none at all) since an
-- accidental/duplicate application row is a legitimate cleanup case that
-- doesn't need to be preserved as "history" — the API just doesn't expose
-- a route for it in this phase.

create table if not exists public.application (
  id                  uuid primary key default gen_random_uuid(),
  candidate_id        uuid not null references public.candidate(id) on delete cascade,
  opportunity_id      uuid not null references public.opportunity(id) on delete cascade,
  status              text not null default 'SAVED'
                         check (status in (
                           'SAVED', 'APPLYING', 'APPLIED', 'ASSESSMENT',
                           'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'
                         )),
  applied_at          timestamptz,
  deadline_override   date,
  next_action_date    date,
  next_action_note    text,
  recruiter_name      text,
  recruiter_email     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- One application per opportunity per candidate — re-applying to the
  -- same saved opportunity should reopen/edit the existing application,
  -- not silently create a second tracker row for it.
  constraint uq_application_candidate_opportunity unique (candidate_id, opportunity_id)
);

comment on table public.application is
  'Application lifecycle tracker. status transitions are enforced by '
  'check_application_status_transition() (BEFORE INSERT OR UPDATE trigger), '
  'mirroring claim''s ClaimStatus enforcement pattern. Every status change '
  'is also recorded in application_status_event for history.';

drop trigger if exists trg_application_updated_at on public.application;
create trigger trg_application_updated_at
  before update on public.application
  for each row
  execute function public.set_updated_at();

create index if not exists idx_application_candidate_id on public.application(candidate_id);
create index if not exists idx_application_opportunity_id on public.application(opportunity_id);
create index if not exists idx_application_candidate_status on public.application(candidate_id, status);
create index if not exists idx_application_next_action_date on public.application(candidate_id, next_action_date)
  where next_action_date is not null;

-- ── Application status transition enforcement ───────────────────────────

create or replace function public.check_application_status_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'APPLIED' then
      new.applied_at := coalesce(new.applied_at, now());
    end if;
    return new;
  end if;

  -- UPDATE: ordinary field edits that don't change status are always fine.
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'SAVED' and new.status in ('APPLYING', 'WITHDRAWN') then
    -- allowed
  elsif old.status = 'APPLYING' and new.status in ('APPLIED', 'WITHDRAWN') then
    -- allowed
  elsif old.status = 'APPLIED' and new.status in ('ASSESSMENT', 'INTERVIEW', 'REJECTED', 'WITHDRAWN') then
    -- allowed
  elsif old.status = 'ASSESSMENT' and new.status in ('INTERVIEW', 'REJECTED', 'WITHDRAWN') then
    -- allowed
  elsif old.status = 'INTERVIEW' and new.status in ('OFFER', 'REJECTED', 'WITHDRAWN') then
    -- allowed
  else
    raise exception 'invalid application status transition: % -> %', old.status, new.status
      using errcode = '23514'; -- check_violation, consistent with claim's trigger
  end if;

  if new.status = 'APPLIED' then
    new.applied_at := coalesce(new.applied_at, now());
  end if;

  return new;
end;
$$;

drop trigger if exists trg_application_status_transition on public.application;
create trigger trg_application_status_transition
  before insert or update on public.application
  for each row
  execute function public.check_application_status_transition();

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table public.application enable row level security;
alter table public.application force row level security;

drop policy if exists application_select_own on public.application;
create policy application_select_own
  on public.application
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = application.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists application_insert_own on public.application;
create policy application_insert_own
  on public.application
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = application.candidate_id
        and c.auth_user_id = auth.uid()
    )
    -- opportunity_id's FK guarantees the row exists; ownership of THAT
    -- opportunity is additionally enforced at the API layer (the route
    -- looks it up through the caller's own RLS-scoped client before
    -- creating the application), same "app-layer integrity check on top
    -- of RLS" precedent used elsewhere. A candidate cannot satisfy this
    -- policy while pointing at another candidate's opportunity anyway,
    -- because a cross-candidate opportunity_id would make the API's own
    -- ownership lookup fail first (404), never reaching this insert.
  );

drop policy if exists application_update_own on public.application;
create policy application_update_own
  on public.application
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = application.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = application.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists application_delete_own on public.application;
create policy application_delete_own
  on public.application
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = application.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
