-- 0025_resume.sql
-- Gate R1 — Resume/profile entity: `resume` + `resume_skill`.
--
-- Design approved in docs/gate-r0-resume-design.md. Schema, RLS, and
-- indexes here match that document exactly; see it for full field-by-field
-- reasoning. This migration is purely additive — no existing table,
-- policy, or column is touched. matchEngine.ts and skillNormalization.ts
-- are not touched by this migration (nor could they be — this is SQL
-- only).
--
-- No matching logic, feed/API route, or frontend change is introduced
-- here. Resume-scoped matching (Gate R2), feed grouping (Gate R3), and
-- the application.resume_id column (Gate R4) are separate, later
-- migrations per the sequencing in the design doc's §8.

-- ── 1. resume ────────────────────────────────────────────────────────────

create table if not exists public.resume (
  id                    uuid primary key default gen_random_uuid(),
  candidate_id          uuid not null references public.candidate(id) on delete cascade,

  label                 text not null check (btrim(label) <> ''),

  -- Free text, not a checked enum — no existing authoritative role-
  -- category list exists anywhere in this schema to constrain it to.
  -- Informational/display only in this gate; see design doc §1 and §9.
  target_role_category  text
                           check (target_role_category is null or btrim(target_role_category) <> ''),

  -- Reuses the existing evidence_source/Storage infrastructure built for
  -- Gate 1a. Nullable: a resume can exist as a named skill-grouping
  -- before any file is attached. ON DELETE SET NULL (not cascade) so
  -- deleting the underlying file never deletes the resume/skill-grouping
  -- itself — mirrors opportunity_match.promoted_opportunity_id.
  evidence_source_id    uuid references public.evidence_source(id) on delete set null,

  -- Archive mechanism. Deliberately a boolean, not a status enum — only
  -- two states exist for a resume, unlike opportunity_source's three.
  is_active             boolean not null default true,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.resume is
  'Candidate-owned, role-specific resume/profile grouping (Gate R1). '
  'References existing skill rows via resume_skill rather than '
  'duplicating skill data. is_active=false is the archive state — '
  'archived resumes are never hard-deleted by the API, matching the '
  'no-DELETE-route precedent set by public.application.';

comment on column public.resume.target_role_category is
  'Free text, no enum. No existing authoritative role-category list '
  'exists in this schema. Informational/display only in Gate R1 — not '
  'read by matchEngine.ts or any matching logic yet.';

drop trigger if exists trg_resume_updated_at on public.resume;
create trigger trg_resume_updated_at
  before update on public.resume
  for each row
  execute function public.set_updated_at();

create index if not exists idx_resume_candidate_id on public.resume(candidate_id);

create index if not exists idx_resume_candidate_active
  on public.resume(candidate_id, is_active);

create index if not exists idx_resume_evidence_source_id
  on public.resume(evidence_source_id)
  where evidence_source_id is not null;

-- ── RLS: resume ──────────────────────────────────────────────────────────
-- Standard ownership-through-candidate subquery pattern, identical in
-- shape to skill/evidence_source/education/etc. since 0007_education.sql.

alter table public.resume enable row level security;
alter table public.resume force row level security;

drop policy if exists resume_select_own on public.resume;
create policy resume_select_own
  on public.resume
  for select
  using (
    exists (
      select 1 from public.candidate c
      where c.id = resume.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists resume_insert_own on public.resume;
create policy resume_insert_own
  on public.resume
  for insert
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = resume.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists resume_update_own on public.resume;
create policy resume_update_own
  on public.resume
  for update
  using (
    exists (
      select 1 from public.candidate c
      where c.id = resume.candidate_id
        and c.auth_user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.candidate c
      where c.id = resume.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists resume_delete_own on public.resume;
create policy resume_delete_own
  on public.resume
  for delete
  using (
    exists (
      select 1 from public.candidate c
      where c.id = resume.candidate_id
        and c.auth_user_id = auth.uid()
    )
  );

-- ── 2. resume_skill ──────────────────────────────────────────────────────
-- Pure many-to-many join table. No payload columns — a skill either
-- belongs to a resume's skill set or it doesn't; matchEngine.ts is not
-- touched, per the standing constraint.

create table if not exists public.resume_skill (
  id          uuid primary key default gen_random_uuid(),
  resume_id   uuid not null references public.resume(id) on delete cascade,
  skill_id    uuid not null references public.skill(id) on delete cascade,

  created_at  timestamptz not null default now(),

  constraint uq_resume_skill unique (resume_id, skill_id)
);

comment on table public.resume_skill is
  'Many-to-many join: which existing skill rows are attached to which '
  'resume. One skill may belong to multiple resumes. No skill data is '
  'duplicated here.';

create index if not exists idx_resume_skill_resume_id on public.resume_skill(resume_id);
create index if not exists idx_resume_skill_skill_id on public.resume_skill(skill_id);

-- ── RLS: resume_skill ────────────────────────────────────────────────────
-- resume_skill has no candidate_id of its own — ownership is two hops
-- away, through resume -> candidate. select/update/delete only need to
-- verify resume ownership (skill ownership is implied: a skill can only
-- ever be linked to one of the caller's own resumes to begin with, once
-- insert is correctly guarded — see insert policy below).
--
-- The INSERT policy is the one place this needs to differ from the
-- typical single-hop pattern: it must verify ownership of BOTH the
-- resume_id AND the skill_id being linked. Checking resume_id alone
-- would let a caller attach another candidate's skill row into their
-- own resume, as long as they own the resume side of the link.

alter table public.resume_skill enable row level security;
alter table public.resume_skill force row level security;

drop policy if exists resume_skill_select_own on public.resume_skill;
create policy resume_skill_select_own
  on public.resume_skill
  for select
  using (
    exists (
      select 1
      from public.resume r
      join public.candidate c on c.id = r.candidate_id
      where r.id = resume_skill.resume_id
        and c.auth_user_id = auth.uid()
    )
  );

drop policy if exists resume_skill_insert_own on public.resume_skill;
create policy resume_skill_insert_own
  on public.resume_skill
  for insert
  with check (
    exists (
      select 1
      from public.resume r
      join public.candidate c on c.id = r.candidate_id
      where r.id = resume_skill.resume_id
        and c.auth_user_id = auth.uid()
    )
    and exists (
      select 1
      from public.skill s
      join public.candidate c on c.id = s.candidate_id
      where s.id = resume_skill.skill_id
        and c.auth_user_id = auth.uid()
    )
  );

-- No UPDATE policy: resume_skill has no mutable payload columns (only
-- resume_id/skill_id, both part of the unique key) — changing either
-- is a delete-and-reinsert, not an update, same as most pure join tables
-- in this schema.

drop policy if exists resume_skill_delete_own on public.resume_skill;
create policy resume_skill_delete_own
  on public.resume_skill
  for delete
  using (
    exists (
      select 1
      from public.resume r
      join public.candidate c on c.id = r.candidate_id
      where r.id = resume_skill.resume_id
        and c.auth_user_id = auth.uid()
    )
  );
