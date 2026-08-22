-- 0022_opportunity_intelligence_foundation.sql
-- Opportunity Intelligence — Phase 1A: database foundation only.
--
-- Architecture decision (locked): Option C from the Opportunity Intelligence
-- architecture design doc. Adds a canonical, system-owned catalog
-- (opportunity_source) and a per-candidate relevance junction table
-- (opportunity_match), and adds a single nullable provenance FK to the
-- existing public.opportunity table. Nothing about the existing
-- candidate-owned opportunity -> application flow changes:
--   - public.opportunity remains candidate-owned, its existing columns,
--     RLS policies, and behavior are untouched.
--   - public.application, application_status_event, application_note are
--     completely untouched by this migration.
--   - opportunity_source_id on public.opportunity is nullable and
--     ON DELETE SET NULL — every existing row gets NULL (manually entered,
--     not provenance-tracked), no backfill, no data transformation.
--
-- No scraper, discovery job, cron/scheduler, matching engine, scoring
-- logic, LLM/embeddings, frontend change, or new API route is introduced
-- by this migration — it is schema only, per the task brief.
--
-- Follows the same conventions as every table since 0007_education.sql:
-- uuid pk, set_updated_at() trigger (defined once in 0002_candidate.sql,
-- reused here — not redefined), RLS enabled + forced, ownership-through-
-- candidate subquery policies for candidate-owned tables.

-- ── 1. opportunity_source ────────────────────────────────────────────────
-- Canonical, system-owned catalog of discovered/seeded opportunities.
-- Not candidate-owned — no candidate_id column at all. Rows here are
-- facts about postings in the world, independent of any one candidate.
-- Regular authenticated users may only SELECT active rows; there is no
-- INSERT/UPDATE/DELETE policy for the authenticated role in this phase —
-- future ingestion will write via the service role, which bypasses RLS
-- entirely, so no service-role policy is created (see RLS section below).

create table if not exists public.opportunity_source (
  id                      uuid primary key default gen_random_uuid(),

  source_type             text not null
                             check (source_type in ('job_board', 'company_site', 'manual_seed', 'other')),
  source_ref              text,
  source_url              text,

  title                   text not null check (btrim(title) <> ''),
  company                 text not null check (btrim(company) <> ''),
  description             text,
  location                text,
  work_mode               text check (work_mode in ('remote', 'hybrid', 'onsite')),
  employment_type         text not null default 'internship'
                             check (employment_type in ('internship', 'co_op', 'full_time', 'part_time')),
  skills                  text[] not null default '{}',
  application_url         text,
  deadline_date           date,
  posted_date             date,

  -- Dedup key for the canonical catalog. Populated by whatever ingestion
  -- code eventually writes here (normalization strategy is out of scope
  -- for this migration); this migration only enforces that it exists and
  -- is unique. See the UNIQUE index below.
  dedup_fingerprint       text not null,

  -- Raw eligibility signals as observed from the source, not a judgement.
  -- NULL means unknown/not stated — it must never be treated as "no
  -- sponsorship" or "no requirement." That interpretation is a matching-
  -- engine concern for a later phase, not something this schema encodes.
  sponsorship_offered     boolean,
  citizenship_requirement text,

  status                  text not null default 'active'
                             check (status in ('active', 'expired', 'removed')),

  first_seen_at           timestamptz not null default now(),
  last_seen_at            timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.opportunity_source is
  'Canonical, system-owned catalog of internship postings (Opportunity '
  'Intelligence Phase 1A). Not candidate-owned. sponsorship_offered = NULL '
  'means unknown, never "no" — do not treat NULL as a negative signal.';

comment on column public.opportunity_source.sponsorship_offered is
  'Raw source signal, tri-state: true/false/NULL. NULL = unknown, not '
  '"sponsorship unavailable". Never collapse to a boolean default.';

drop trigger if exists trg_opportunity_source_updated_at on public.opportunity_source;
create trigger trg_opportunity_source_updated_at
  before update on public.opportunity_source
  for each row
  execute function public.set_updated_at();

create unique index if not exists uq_opportunity_source_dedup_fingerprint
  on public.opportunity_source (dedup_fingerprint);

create index if not exists idx_opportunity_source_status
  on public.opportunity_source (status);

-- ── RLS: opportunity_source ─────────────────────────────────────────────

alter table public.opportunity_source enable row level security;
alter table public.opportunity_source force row level security;

-- Any authenticated candidate may read active catalog rows. No candidate
-- ownership concept applies here, so this is a plain auth check, not the
-- candidate-subquery pattern used elsewhere.
drop policy if exists opportunity_source_select_active on public.opportunity_source;
create policy opportunity_source_select_active
  on public.opportunity_source
  for select
  using (
    auth.uid() is not null
    and status = 'active'
  );

-- Deliberately no INSERT/UPDATE/DELETE policy for the authenticated role.
-- Future ingestion writes via the service-role key, which bypasses RLS
-- entirely — creating a "service role" policy here would be meaningless
-- (service role never evaluates policies) and would only create a false
-- impression that write access is governed by RLS on this table.

-- ── 2. opportunity_match ────────────────────────────────────────────────
-- Per-candidate relevance/rank of a catalog opportunity. Candidate-owned,
-- same ownership pattern as every other candidate-owned table. Distinct
-- from opportunity.inbox_status (that field describes triage of a
-- candidate's own manually-created opportunity row; this describes triage
-- of a *candidate's view of a canonical opportunity_source row*, before
-- any opportunity row exists for them at all).

create table if not exists public.opportunity_match (
  id                        uuid primary key default gen_random_uuid(),
  candidate_id              uuid not null references public.candidate(id) on delete cascade,
  opportunity_source_id     uuid not null references public.opportunity_source(id) on delete cascade,

  match_score               numeric not null check (match_score >= 0 and match_score <= 100),
  match_breakdown           jsonb not null default '{}'::jsonb,

  eligibility_status        text not null default 'unknown'
                               check (eligibility_status in ('eligible', 'ineligible', 'unknown')),

  inbox_status              text not null default 'new'
                               check (inbox_status in ('new', 'saved', 'dismissed')),
  is_priority               boolean not null default false,

  -- Set once a candidate acts on this match by promoting it into their own
  -- opportunity row (existing manual-create code path, source =
  -- 'discovered' or similar — promotion logic is out of scope for this
  -- migration). ON DELETE SET NULL: if the promoted opportunity is later
  -- deleted, the match record itself is historical and should survive.
  promoted_opportunity_id   uuid references public.opportunity(id) on delete set null,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- One match row per candidate per canonical opportunity — re-matching
  -- should update the existing row's score, not create a duplicate.
  -- Mirrors application's uq_application_candidate_opportunity.
  constraint uq_opportunity_match_candidate_source unique (candidate_id, opportunity_source_id)
);

comment on table public.opportunity_match is
  'Per-candidate relevance/rank against public.opportunity_source '
  '(Opportunity Intelligence Phase 1A). Candidate-owned. Distinct from '
  'opportunity.inbox_status, which triages a candidate''s own manually '
  'created opportunity rows.';

drop trigger if exists trg_opportunity_match_updated_at on public.opportunity_match;
create trigger trg_opportunity_match_updated_at
  before update on public.opportunity_match
  for each row
  execute function public.set_updated_at();

create index if not exists idx_opportunity_match_candidate_inbox_status
  on public.opportunity_match (candidate_id, inbox_status);

create index if not exists idx_opportunity_match_candidate_score
  on public.opportunity_match (candidate_id, match_score);

create index if not exists idx_opportunity_match_opportunity_source_id
  on public.opportunity_match (opportunity_source_id);

create index if not exists idx_opportunity_match_candidate_eligibility
  on public.opportunity_match (candidate_id, eligibility_status);

-- ── RLS: opportunity_match ──────────────────────────────────────────────
-- Exact same ownership-through-candidate pattern as public.opportunity
-- (0017_opportunity.sql) — copied verbatim, only the table name changes.

alter table public.opportunity_match enable row level security;
alter table public.opportunity_match force row level security;

drop policy if exists opportunity_match_select_own on public.opportunity_match;
create policy opportunity_match_select_own
  on public.opportunity_match
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = opportunity_match.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists opportunity_match_insert_own on public.opportunity_match;
create policy opportunity_match_insert_own
  on public.opportunity_match
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = opportunity_match.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists opportunity_match_update_own on public.opportunity_match;
create policy opportunity_match_update_own
  on public.opportunity_match
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = opportunity_match.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = opportunity_match.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists opportunity_match_delete_own on public.opportunity_match;
create policy opportunity_match_delete_own
  on public.opportunity_match
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = opportunity_match.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

-- ── 3. public.opportunity — single additive column ──────────────────────
-- Provenance only. NULL for every existing row (manually entered, not
-- provenance-tracked) and for every future manually entered row. No other
-- column, constraint, trigger, or RLS policy on public.opportunity is
-- touched by this migration.

alter table public.opportunity
  add column if not exists opportunity_source_id uuid
    references public.opportunity_source(id) on delete set null;

comment on column public.opportunity.opportunity_source_id is
  'Nullable provenance link to public.opportunity_source. NULL = manually '
  'entered / not provenance-tracked (true for every pre-existing row and '
  'every future manual entry). Set only when an opportunity row is '
  'promoted from a candidate''s opportunity_match. Added by '
  '0022_opportunity_intelligence_foundation.sql — no other opportunity '
  'column, constraint, trigger, or RLS policy is modified.';

create index if not exists idx_opportunity_opportunity_source_id
  on public.opportunity (opportunity_source_id)
  where opportunity_source_id is not null;