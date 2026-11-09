-- 0033_opportunity_quality_signals.sql
-- Additive quality labels for deterministic opportunity screening.
-- Listings are NEVER deleted or rejected because of these signals.
-- A high_risk label means "review carefully", not confirmed fraud.

alter table public.opportunity_source
  add column if not exists quality_status text not null default 'clear'
    check (quality_status in ('clear', 'review', 'high_risk')),
  add column if not exists quality_score integer not null default 100
    check (quality_score >= 0 and quality_score <= 100),
  add column if not exists quality_flags text[] not null default '{}';

comment on column public.opportunity_source.quality_status is
  'Deterministic screening label: clear, review, or high_risk. Signals are not proof of fraud and never cause deletion.';
comment on column public.opportunity_source.quality_score is
  'Transparent deterministic quality score from 0 to 100; separate from candidate match_score.';
comment on column public.opportunity_source.quality_flags is
  'Machine-readable quality review flags; empty array means no configured warning signal was detected.';
