-- 0029_opportunity_source_name.sql
-- A3.3.2 (Opportunity Quality — Source Quality) — persists which adapter
-- produced a given opportunity_source row.
--
-- Before this migration, CanonicalListing.source_name ("adzuna" /
-- "remoteok") was consumed exactly once, by dedupFingerprint.ts, which
-- hashes it one-way into dedup_fingerprint. There was no other column on
-- this table that recorded it, and source_type ('job_board') is a coarse
-- category shared by every current adapter — it cannot distinguish which
-- one produced a row. Confirmed by the A3.3 audit: it is currently
-- impossible to query "every row that came from RemoteOK."
--
-- This is foundational, not a feature by itself: it doesn't change any
-- ranking, matching, or display behavior on its own. It's the minimum
-- prerequisite for any future per-source reliability signal (e.g. "this
-- source's listings tend to have working application links"), which is
-- explicitly out of scope for A3.3 itself (no repository evidence
-- justifies a reputation system yet — see the A3.3 design review, §6C).
--
-- Nullable, not backfilled: existing rows (ingested before this
-- migration) simply have source_name = NULL going forward; attribution
-- starts from the next ingestion run. This mirrors 0028's own posture on
-- opportunity.opportunity_source_id (nullable, no backfill attempted) and
-- avoids inventing a value for rows where the original source is not
-- reliably re-derivable after the fact.
--
-- matchEngine.ts and skillNormalization.ts are not touched (SQL only).

alter table public.opportunity_source
  add column if not exists source_name text;

comment on column public.opportunity_source.source_name is
  'Which ingestion adapter produced this row (e.g. ''adzuna'', ''remoteok''), '
  'taken directly from CanonicalListing.source_name at write time '
  '(writeOpportunitySource.ts). NULL for rows ingested before this column '
  'existed — not backfilled. Distinct from source_type, which is a coarse, '
  'adapter-shared category (e.g. ''job_board'') and cannot answer '
  '"which source". Purely descriptive: nothing currently reads this column '
  'back to change matching, ranking, or display behavior.';

create index if not exists idx_opportunity_source_source_name
  on public.opportunity_source (source_name)
  where source_name is not null;
