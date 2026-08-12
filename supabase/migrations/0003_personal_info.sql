-- 0003_personal_info.sql
-- Phase 0 / Day 1 — PersonalInfo (PII domain).
-- 1:1 with candidate. Deliberately excludes government IDs / DOB per the
-- approved architecture (Candidate Truth Layer Phase 0, §PII boundary):
-- InternshipOS has no legitimate use for them at the application stage.

create table if not exists public.personal_info (
  candidate_id       uuid primary key references public.candidate(id) on delete cascade,
  legal_first_name   text not null,
  legal_last_name    text not null,
  preferred_name     text,
  email              text not null,
  phone              text,
  location_city      text,
  location_country   text not null,
  pronouns           text,
  updated_at         timestamptz not null default now(),
  constraint personal_info_email_format check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

comment on table public.personal_info is
  'PII domain. Never read by matching/generation code paths or sent to an LLM.';

drop trigger if exists trg_personal_info_updated_at on public.personal_info;
create trigger trg_personal_info_updated_at
  before update on public.personal_info
  for each row
  execute function public.set_updated_at();
