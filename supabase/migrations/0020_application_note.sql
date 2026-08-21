-- 0020_application_note.sql
-- Phase 1 — Application notes.
--
-- Task brief §4.F: "Allow the student to record: custom notes, recruiter
-- contact, interview notes, next action, relevant links. Keep this
-- lightweight." This is one small table with a note_type tag rather than
-- separate tables per note kind — structured recruiter-contact fields that
-- the dashboard/reminders logic needs to query directly
-- (recruiter_name/recruiter_email, next_action_date/next_action_note)
-- already live as real columns on public.application (0018), so they're
-- queryable without scanning free-text notes. This table is for the
-- free-form, append-as-you-go log: what was actually said on a call, a
-- pasted job-posting link, a reminder-to-self — content with no other
-- natural home. Unlike application_status_event, notes are NOT an
-- immutable history log — a student fixing a typo in their own note is a
-- normal edit, not a fact that needs to survive as history.
--
-- Same ownership pattern as claim/application_status_event: candidate_id
-- denormalized onto the row so RLS doesn't need to join through
-- application. application_id ownership (this note's application belongs
-- to this same candidate) is validated at the API layer before insert,
-- same "app-layer integrity check on top of RLS" precedent as claim's
-- subject_entity_id and application's opportunity_id.

create table if not exists public.application_note (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references public.application(id) on delete cascade,
  candidate_id    uuid not null references public.candidate(id) on delete cascade,
  note_type       text not null default 'general'
                     check (note_type in ('general', 'recruiter_contact', 'interview', 'next_action', 'link')),
  content         text not null check (btrim(content) <> ''),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.application_note is
  'Lightweight, editable free-form notes on an application. Not a history '
  'log (see application_status_event for that) — ordinary edits/deletes '
  'are expected and allowed.';

drop trigger if exists trg_application_note_updated_at on public.application_note;
create trigger trg_application_note_updated_at
  before update on public.application_note
  for each row
  execute function public.set_updated_at();

create index if not exists idx_application_note_application_id
  on public.application_note(application_id, created_at);
create index if not exists idx_application_note_candidate_id on public.application_note(candidate_id);

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table public.application_note enable row level security;
alter table public.application_note force row level security;

drop policy if exists application_note_select_own on public.application_note;
create policy application_note_select_own
  on public.application_note
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = application_note.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists application_note_insert_own on public.application_note;
create policy application_note_insert_own
  on public.application_note
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = application_note.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists application_note_update_own on public.application_note;
create policy application_note_update_own
  on public.application_note
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = application_note.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = application_note.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists application_note_delete_own on public.application_note;
create policy application_note_delete_own
  on public.application_note
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = application_note.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
