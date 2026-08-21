-- 0019_application_status_event.sql
-- Phase 1 — Application status history.
--
-- Task brief §4.D: "Do not merely overwrite status without recording
-- meaningful changes." This table is that history. Written by the API
-- layer (api/src/routes/application.ts's PATCH /applications/:id/status),
-- in the same request that updates application.status — not by a DB
-- trigger. This is a deliberate deviation from claim's pattern (where the
-- transition trigger lives entirely in the DB): a history *event* needs a
-- human-facing note field the caller supplies per-transition (e.g. "recruiter
-- said decision expected next week"), which only the API request body has
-- access to; a trigger has no way to receive that. The transition
-- *legality* check itself (check_application_status_transition) still
-- lives in the DB trigger on public.application, same as claim — this
-- table only records what happened, it does not gate what's allowed.
--
-- Immutable by design: no UPDATE or DELETE RLS policy exists, mirroring
-- claim's "no DELETE policy at all" permanence rule. candidate_id is
-- denormalized onto this table (rather than requiring a join through
-- application) purely so RLS ownership uses the same simple pattern as
-- every other table.

create table if not exists public.application_status_event (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references public.application(id) on delete cascade,
  candidate_id    uuid not null references public.candidate(id) on delete cascade,
  from_status     text,
  to_status       text not null
                     check (to_status in (
                       'SAVED', 'APPLYING', 'APPLIED', 'ASSESSMENT',
                       'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN'
                     )),
  note            text,
  created_at      timestamptz not null default now()
);

comment on table public.application_status_event is
  'Immutable application status history — no UPDATE/DELETE RLS policy, '
  'same permanence rule as claim. Written by the API alongside each '
  'application.status change, not by a DB trigger (see migration header).';

create index if not exists idx_application_status_event_application_id
  on public.application_status_event(application_id, created_at);
create index if not exists idx_application_status_event_candidate_id
  on public.application_status_event(candidate_id);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- select + insert only. No update/delete policy at all (permanent record).

alter table public.application_status_event enable row level security;
alter table public.application_status_event force row level security;

drop policy if exists application_status_event_select_own on public.application_status_event;
create policy application_status_event_select_own
  on public.application_status_event
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = application_status_event.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists application_status_event_insert_own on public.application_status_event;
create policy application_status_event_insert_own
  on public.application_status_event
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = application_status_event.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
