-- 0031_screening_answer.sql
-- Gate R8 follow-up — a candidate-maintained reference library of
-- screening-question answers (e.g. "Are you willing to relocate?",
-- "Do you require visa sponsorship now or in the future?", "What's your
-- expected hourly rate?").
--
-- IMPORTANT SCOPING NOTE, matching this codebase's "don't guess" posture
-- elsewhere (leverAdapter.ts's deliberate refusal to answer custom
-- questions it can't discover; coverLetterTemplate.ts's placeholder
-- line rather than fabricated enthusiasm): this table is NOT wired into
-- attemptAtsSubmission.ts, and does not auto-fill anything on a real
-- submission. There is no reliable way to discover a Lever posting's
-- actual custom-question schema from its public read API (same
-- limitation documented in leverAdapter.ts's header), so there is
-- nothing here to safely auto-match against yet. This is a personal
-- reference library the candidate can copy from manually today, and a
-- plausible future input to real auto-fill IF a way to discover a
-- posting's actual questions is ever confirmed — that is a separate,
-- later decision, not something this migration or its route claims to
-- do.
--
-- Same structural conventions as 0007_education.sql: uuid pk,
-- candidate_id fk with on delete cascade, set_updated_at trigger,
-- RLS enabled + forced, ownership-through-candidate subquery pattern,
-- table + policies co-located in one migration since this is a single
-- self-contained new entity.

create table if not exists public.screening_answer (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references public.candidate(id) on delete cascade,
  question      text not null,
  answer        text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint screening_answer_question_not_blank check (length(trim(question)) > 0),
  constraint screening_answer_answer_not_blank check (length(trim(answer)) > 0)
);

comment on table public.screening_answer is
  'Candidate-maintained reference library of screening-question answers '
  '(work authorization phrasing, relocation, expected rate, etc.). NOT '
  'auto-matched against any posting''s actual custom questions — no '
  'reliable way to discover those from Lever''s public read API. Purely '
  'a personal reference the candidate copies from manually today.';

drop trigger if exists trg_screening_answer_updated_at on public.screening_answer;
create trigger trg_screening_answer_updated_at
  before update on public.screening_answer
  for each row
  execute function public.set_updated_at();

create index if not exists idx_screening_answer_candidate_id on public.screening_answer(candidate_id);

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table public.screening_answer enable row level security;
alter table public.screening_answer force row level security;

drop policy if exists screening_answer_select_own on public.screening_answer;
create policy screening_answer_select_own
  on public.screening_answer
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = screening_answer.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists screening_answer_insert_own on public.screening_answer;
create policy screening_answer_insert_own
  on public.screening_answer
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = screening_answer.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists screening_answer_update_own on public.screening_answer;
create policy screening_answer_update_own
  on public.screening_answer
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = screening_answer.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = screening_answer.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists screening_answer_delete_own on public.screening_answer;
create policy screening_answer_delete_own
  on public.screening_answer
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = screening_answer.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
