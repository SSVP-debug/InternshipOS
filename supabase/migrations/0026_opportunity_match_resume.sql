-- 0026_opportunity_match_resume.sql
-- Gate R2 — resume-scoped match scores on opportunity_match.
--
-- Per docs/gate-r0-resume-design.md §5, chosen option (your explicit
-- decision): extend opportunity_match with a nullable resume_id, rather
-- than a separate resume_opportunity_match table. This migration is the
-- follow-through on that decision, including the two consequences it
-- flagged as needing resolution here, not glossed over:
--
-- 1. UNIQUENESS: Postgres treats NULL as non-colliding in a plain unique
--    index, so a naive unique(candidate_id, opportunity_source_id,
--    resume_id) would let unlimited duplicate rows accumulate for every
--    candidate with resume_id IS NULL (i.e. every candidate today,
--    before Gate R1 even existed) — silently breaking the existing
--    "re-matching updates the row" guarantee this table has had since
--    0022_opportunity_intelligence_foundation.sql. Fixed here by
--    replacing the single unique constraint with two partial unique
--    indexes: one for resume_id IS NULL (identical in effect to the
--    original constraint), one for resume_id IS NOT NULL.
--
-- 2. UPSERT MECHANICS: Postgres will not infer a partial unique index as
--    an ON CONFLICT target unless the INSERT statement's own ON CONFLICT
--    clause repeats the index's WHERE predicate. supabase-js's
--    `.upsert({ onConflict })` only accepts a column list — it cannot
--    express that WHERE clause — so the plain client-side upsert
--    runMatchingForCandidate.ts used before this migration would now
--    fail outright (not silently misbehave — it would error, since
--    Postgres refuses to guess which partial index you meant). This
--    migration adds a SQL function, upsert_opportunity_match_batch(),
--    that performs the correct two-branch INSERT ... ON CONFLICT (one
--    per partial index) in a single round trip. runMatchingForCandidate.ts
--    is updated in this same gate to call it via .rpc() instead of
--    .upsert() — see that file's own comments for why.
--
-- matchEngine.ts and skillNormalization.ts are not touched by this
-- migration, nor could they be (SQL only, no scoring logic here).
--
-- No frontend or feed-route change is introduced here — that is Gate R3.

-- ── 1. resume_id column ─────────────────────────────────────────────────

alter table public.opportunity_match
  add column if not exists resume_id uuid references public.resume(id) on delete set null;

comment on column public.opportunity_match.resume_id is
  'NULL = candidate-level match (no resume scoping) — the original, '
  'still-supported mode. NOT NULL = this match score was computed using '
  'only that resume''s linked skills (via resume_skill), per Gate R2. '
  'ON DELETE SET NULL: deleting a resume degrades its matches to '
  'candidate-level history rather than deleting them — but see the '
  'partial-unique-index note below, since a degraded row could then '
  'collide with an existing NULL-resume row for the same '
  '(candidate_id, opportunity_source_id). That collision is handled at '
  'the database level: ON DELETE SET NULL alone cannot dedupe, so the '
  'application layer (Gate R2 orchestrator) does not currently re-run '
  'matching automatically on resume deletion. A future gate can add a '
  'cleanup pass if this proves to matter in practice — not solved '
  'speculatively here.';

-- ── 2. Ownership integrity: resume_id, if set, must belong to the same
--    candidate as the match row itself. This cannot be a CHECK
--    constraint (CHECK cannot query another table) and cannot rely on
--    RLS alone, because this table is written by the service-role
--    matching orchestrator, which bypasses RLS entirely — same reason
--    public.application's status-transition rule is a trigger, not a
--    CHECK. ──────────────────────────────────────────────────────────

create or replace function public.check_opportunity_match_resume_candidate()
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
      raise exception 'opportunity_match.resume_id must belong to the same candidate_id as the match row'
        using errcode = '23514'; -- check_violation, consistent with other trigger-enforced invariants
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_opportunity_match_resume_candidate on public.opportunity_match;
create trigger trg_opportunity_match_resume_candidate
  before insert or update on public.opportunity_match
  for each row
  execute function public.check_opportunity_match_resume_candidate();

-- ── 3. Uniqueness: replace the single constraint with two partial
--    unique indexes (see design note 1 above). ────────────────────────

alter table public.opportunity_match
  drop constraint if exists uq_opportunity_match_candidate_source;

create unique index if not exists uq_opportunity_match_candidate_source_no_resume
  on public.opportunity_match (candidate_id, opportunity_source_id)
  where resume_id is null;

create unique index if not exists uq_opportunity_match_candidate_source_resume
  on public.opportunity_match (candidate_id, opportunity_source_id, resume_id)
  where resume_id is not null;

create index if not exists idx_opportunity_match_resume_id
  on public.opportunity_match (resume_id)
  where resume_id is not null;

-- ── 4. Batch upsert function (see design note 2 above). ─────────────────
-- SECURITY INVOKER (the default — not redeclared as SECURITY DEFINER):
-- runs with the calling role's own privileges and RLS policies still
-- apply to the INSERT/UPDATE inside it. This is deliberate, not an
-- oversight — it means this function could not be used to bypass
-- opportunity_match's existing ownership RLS even if it were ever
-- called by the `authenticated` role. Execute is nonetheless explicitly
-- restricted to service_role below, matching the "service-role-only
-- write path, explicitly authorized rather than left to default PUBLIC
-- grants" convention already used for opportunity_source writes
-- (0022_opportunity_intelligence_foundation.sql) — this function is not
-- part of the current API surface for candidates, only the matching
-- orchestrator scripts.

create or replace function public.upsert_opportunity_match_batch(p_rows jsonb)
returns integer
language plpgsql
as $$
declare
  v_count_no_resume integer := 0;
  v_count_resume integer := 0;
begin
  with incoming as (
    select
      (r->>'candidate_id')::uuid           as candidate_id,
      (r->>'opportunity_source_id')::uuid  as opportunity_source_id,
      nullif(r->>'resume_id', '')::uuid    as resume_id,
      (r->>'match_score')::numeric         as match_score,
      (r->>'eligibility_status')::text     as eligibility_status,
      coalesce(r->'match_breakdown', '{}'::jsonb) as match_breakdown
    from jsonb_array_elements(p_rows) as r
  )
  insert into public.opportunity_match
    (candidate_id, opportunity_source_id, resume_id, match_score, eligibility_status, match_breakdown)
  select candidate_id, opportunity_source_id, resume_id, match_score, eligibility_status, match_breakdown
  from incoming
  where resume_id is null
  on conflict (candidate_id, opportunity_source_id) where resume_id is null
  do update set
    match_score        = excluded.match_score,
    eligibility_status  = excluded.eligibility_status,
    match_breakdown     = excluded.match_breakdown,
    updated_at          = now();

  get diagnostics v_count_no_resume = row_count;

  with incoming as (
    select
      (r->>'candidate_id')::uuid           as candidate_id,
      (r->>'opportunity_source_id')::uuid  as opportunity_source_id,
      nullif(r->>'resume_id', '')::uuid    as resume_id,
      (r->>'match_score')::numeric         as match_score,
      (r->>'eligibility_status')::text     as eligibility_status,
      coalesce(r->'match_breakdown', '{}'::jsonb) as match_breakdown
    from jsonb_array_elements(p_rows) as r
  )
  insert into public.opportunity_match
    (candidate_id, opportunity_source_id, resume_id, match_score, eligibility_status, match_breakdown)
  select candidate_id, opportunity_source_id, resume_id, match_score, eligibility_status, match_breakdown
  from incoming
  where resume_id is not null
  on conflict (candidate_id, opportunity_source_id, resume_id) where resume_id is not null
  do update set
    match_score        = excluded.match_score,
    eligibility_status  = excluded.eligibility_status,
    match_breakdown     = excluded.match_breakdown,
    updated_at          = now();

  get diagnostics v_count_resume = row_count;

  return v_count_no_resume + v_count_resume;
end;
$$;

comment on function public.upsert_opportunity_match_batch(jsonb) is
  'Batch upsert for opportunity_match that correctly targets one of the '
  'two partial unique indexes per row, based on whether resume_id is '
  'present — see 0026_opportunity_match_resume.sql design notes for why '
  'a plain client-side .upsert() call can no longer do this. Called via '
  '.rpc() from runMatchingForCandidate.ts. Not part of the candidate-'
  'facing API surface.';

revoke execute on function public.upsert_opportunity_match_batch(jsonb) from public;
grant execute on function public.upsert_opportunity_match_batch(jsonb) to service_role;
