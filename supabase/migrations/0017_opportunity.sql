-- 0017_opportunity.sql
-- Phase 1 ("InternshipOS product loop") — Opportunity entity.
--
-- Scope decision (documented per project convention — see
-- docs/decisions-log.md D-003): Opportunity is candidate-owned, not a
-- shared/global catalog. Per the task brief §8 ("Discovery / job
-- ingestion"), the first usable version uses a manual/import-based
-- workflow — each student adds the opportunities they find. This keeps
-- the ownership model identical to every existing table (RLS via
-- candidate_id -> candidate.auth_user_id = auth.uid()), avoids inventing
-- a public/shared-read policy this early, and avoids a scraping/ingestion
-- architecture that the brief explicitly says not to build yet. A shared
-- catalog (multiple candidates seeing the same opportunity row) is a
-- reasonable Phase 2 evolution but is NOT this migration — it would need
-- a real dedup/source-of-truth design, which is out of scope here.
--
-- Follows the same conventions as every table since 0007_education.sql:
-- uuid pk, candidate_id fk on delete cascade, set_updated_at() trigger,
-- RLS enabled + forced, ownership-through-candidate subquery policies.

create table if not exists public.opportunity (
  id                uuid primary key default gen_random_uuid(),
  candidate_id      uuid not null references public.candidate(id) on delete cascade,
  title             text not null check (btrim(title) <> ''),
  company           text not null check (btrim(company) <> ''),
  description       text,
  location          text,
  work_mode         text check (work_mode in ('remote', 'hybrid', 'onsite')),
  employment_type   text not null default 'internship'
                       check (employment_type in ('internship', 'co_op', 'full_time', 'part_time')),
  skills            text[] not null default '{}',
  application_url   text,
  source            text not null default 'manual'
                       check (source in ('manual', 'referral', 'company_site', 'job_board', 'career_fair', 'other')),
  deadline_date     date,
  posted_date       date,
  -- Inbox triage state — the DISCOVER -> PRIORITIZE -> SAVE steps of the
  -- product loop. 'new' = added but not yet triaged, 'saved' = kept,
  -- 'dismissed' = not interested. This is deliberately NOT the same thing
  -- as Application.status: an opportunity can be saved/dismissed without
  -- ever becoming an application, and (once an application exists) the
  -- opportunity's inbox state is no longer the source of truth for
  -- progress — the application is.
  inbox_status      text not null default 'new' check (inbox_status in ('new', 'saved', 'dismissed')),
  is_priority       boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.opportunity is
  'Candidate-owned internship opportunities (manual/import-based discovery, '
  'Phase 1). Not a shared catalog — see migration header for reasoning.';

drop trigger if exists trg_opportunity_updated_at on public.opportunity;
create trigger trg_opportunity_updated_at
  before update on public.opportunity
  for each row
  execute function public.set_updated_at();

create index if not exists idx_opportunity_candidate_id on public.opportunity(candidate_id);
create index if not exists idx_opportunity_candidate_inbox_status on public.opportunity(candidate_id, inbox_status);
create index if not exists idx_opportunity_deadline on public.opportunity(candidate_id, deadline_date)
  where deadline_date is not null;

-- ── RLS ──────────────────────────────────────────────────────────────────

alter table public.opportunity enable row level security;
alter table public.opportunity force row level security;

drop policy if exists opportunity_select_own on public.opportunity;
create policy opportunity_select_own
  on public.opportunity
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = opportunity.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists opportunity_insert_own on public.opportunity;
create policy opportunity_insert_own
  on public.opportunity
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = opportunity.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists opportunity_update_own on public.opportunity;
create policy opportunity_update_own
  on public.opportunity
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = opportunity.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = opportunity.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists opportunity_delete_own on public.opportunity;
create policy opportunity_delete_own
  on public.opportunity
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = opportunity.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );
