-- 0028_opportunity_source_provenance.sql
-- Gate R5 — opportunity.opportunity_source_id: links a candidate-owned
-- `opportunity` row back to the catalog `opportunity_source` row it was
-- created from, when it was auto-created by the new bulk-apply endpoint
-- (POST /opportunity-matches/bulk-apply) rather than manually entered by
-- the candidate.
--
-- This exists for two reasons, decided together with you before this
-- migration was written:
--   1. PROVENANCE — a straightforward "where did this come from" fact,
--      nullable because manually-entered opportunities (0017_opportunity.sql's
--      original and still-supported mode) have no source row to point at.
--   2. DEDUP — the actual mechanism that lets bulk-apply refuse to create
--      a second `opportunity` (and therefore a second `application`) for
--      a posting the candidate already has one for, even when the two
--      attempts came from different opportunity_match rows (different
--      resumes) for the same opportunity_source. See the partial unique
--      index below — this is the real, DB-enforced half of "same
--      candidate + same underlying posting = one opportunity, one
--      application," not just an application-layer check that bulk-apply
--      could accidentally skip.
--
-- This is EXACT-match dedup only (same opportunity_source_id) — it does
-- not attempt fuzzy matching (e.g. same company+title from two different
-- source_types/listings of the same real-world posting). That's the
-- other option Gate R6 was originally scoped to decide between; exact-
-- match was pulled forward into this migration because bulk-apply needed
-- SOME dedup mechanism to be safe to ship at all, but fuzzy/cross-source
-- matching remains explicitly open for Gate R6 to pick up, not resolved
-- here.
--
-- matchEngine.ts and skillNormalization.ts are not touched (SQL only).

alter table public.opportunity
  add column if not exists opportunity_source_id uuid references public.opportunity_source(id) on delete set null;

comment on column public.opportunity.opportunity_source_id is
  'Which opportunity_source row (if any) this candidate-owned opportunity '
  'was auto-created from by POST /opportunity-matches/bulk-apply. NULL for '
  'manually-entered opportunities (0017_opportunity.sql''s original mode) '
  '— manual entry never sets this column. ON DELETE SET NULL: if the '
  'source posting is later removed from the catalog, this candidate''s own '
  'opportunity/application record is unaffected — it just loses the '
  'provenance link, exactly like resume_id''s treatment elsewhere in this '
  'schema. See the partial unique index below for the dedup guarantee this '
  'column exists to enable.';

-- The actual dedup mechanism (see header). Partial (not a plain unique
-- constraint) for the same reason opportunity_match's two indexes are
-- partial (0026_opportunity_match_resume.sql): NULL never collides with
-- NULL in a unique index, so manually-entered opportunities
-- (opportunity_source_id IS NULL, the overwhelming majority of existing
-- rows) are completely unaffected — candidates can still manually add as
-- many opportunities as they want, including ones that happen to
-- describe the same real posting, exactly as before this migration.
create unique index if not exists uq_opportunity_candidate_source
  on public.opportunity (candidate_id, opportunity_source_id)
  where opportunity_source_id is not null;

create index if not exists idx_opportunity_source_id
  on public.opportunity (opportunity_source_id)
  where opportunity_source_id is not null;
