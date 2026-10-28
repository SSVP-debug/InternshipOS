-- 0032_telegram_notification_delivery.sql
-- Personal MVP Telegram notifier delivery ledger.
--
-- The first implementation intentionally supports ONE configured candidate
-- and ONE Telegram chat via GitHub Actions secrets. Do not use a shared
-- TELEGRAM_CHAT_ID to notify all candidates: a future multi-user version
-- needs candidate-owned Telegram linking/preferences and consent.
--
-- This table records a successful notification per (candidate, posting),
-- not per resume-scoped match. That prevents the same posting from being
-- sent repeatedly when the matching engine has candidate-level and
-- resume-scoped rows for it. Only the trusted scheduled script uses it.
-- No authenticated/anon policies or grants are provided.

create table if not exists public.telegram_notification_delivery (
  candidate_id uuid not null references public.candidate(id) on delete cascade,
  opportunity_source_id uuid not null references public.opportunity_source(id) on delete cascade,
  opportunity_match_id uuid references public.opportunity_match(id) on delete set null,
  match_score numeric not null check (match_score >= 0 and match_score <= 100),
  delivered_at timestamptz not null default now(),
  constraint uq_telegram_delivery_candidate_source
    unique (candidate_id, opportunity_source_id)
);

comment on table public.telegram_notification_delivery is
  'Service-role-only delivery ledger for the single-candidate Telegram MVP. '
  'A row means a Telegram digest containing this posting was accepted by the '
  'Telegram API; this is best-effort deduplication, not exactly-once delivery.';

alter table public.telegram_notification_delivery enable row level security;
alter table public.telegram_notification_delivery force row level security;

revoke all on public.telegram_notification_delivery from anon, authenticated;
grant all on public.telegram_notification_delivery to service_role;
