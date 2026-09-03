-- 0027_application_resume.sql
-- Gate R4 — application.resume_id: which resume was used for this
-- application. Per docs/gate-r0-resume-design.md §6, your refinement was
-- already satisfied by application's existing schema — its uniqueness
-- stays candidate + opportunity (0018_application.sql's
-- uq_application_candidate_opportunity, UNCHANGED and untouched by this
-- migration); resume is an attribute of an application, never part of
-- what makes it unique. This migration only adds that attribute.
--
-- Tracking only, per your Gate R0 answer — this records which resume was
-- used, it does not submit anything to any external platform.
--
-- matchEngine.ts and skillNormalization.ts are not touched (SQL only).

alter table public.application
  add column if not exists resume_id uuid references public.resume(id) on delete set null;

comment on column public.application.resume_id is
  'Which resume (if any) was used for this application — tracking only, '
  'set at creation via POST /applications or corrected later via PUT '
  '/applications/:id (see api/src/routes/application.ts). NOT derived '
  'automatically from opportunity_match.resume_id/promoted_opportunity_id '
  '— a candidate can mark more than one resume''s match as promoted '
  'toward the same claimed opportunity (nothing in the schema prevents '
  'that), which would make "the" resume ambiguous to infer; the candidate '
  'states it explicitly instead, same posture as opportunity_id itself. '
  'ON DELETE SET NULL: deleting a resume degrades the application to '
  '"resume used: no longer known" rather than deleting or blocking '
  'deletion of application history — mirrors resume_id''s own treatment '
  'on opportunity_match (0026_opportunity_match_resume.sql) and '
  'promoted_opportunity_id''s treatment on opportunity_match before it.';

-- Same ownership-consistency concern as opportunity_match.resume_id
-- (0026_opportunity_match_resume.sql): a CHECK constraint cannot query
-- another table, and RLS's own WITH CHECK, while sufficient for
-- candidate-facing writes here (application IS written through
-- req.supabase, unlike opportunity_match), is worth backing with a
-- trigger anyway for defense in depth — consistent with this schema's
-- existing posture of not relying on a single enforcement layer for an
-- invariant this easy to get wrong in application code (e.g. a future
-- route change that switches to a service-role client without noticing
-- this constraint existed).
create or replace function public.check_application_resume_candidate()
returns trigger
language plpgsql
as $$
begin
  if new.resume_id is not null then
    if not exists (
      select 1 from public.resume r
      where r.id = new.resume_id
        and r.candidate_id = new.candidate_id
    ) then
      raise exception 'application.resume_id must belong to the same candidate_id as the application row'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_application_resume_candidate on public.application;
create trigger trg_application_resume_candidate
  before insert or update on public.application
  for each row
  execute function public.check_application_resume_candidate();

create index if not exists idx_application_resume_id
  on public.application (resume_id)
  where resume_id is not null;
