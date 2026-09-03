# Gate R0 — Resume/Profile Schema Design

**Status:** Design only. No migrations, application code, matching logic,
or frontend touched by this document. Pending your review and explicit
approval before Gate R1 (actual migration) begins.

**Scope of this gate:** `resume` and `resume_skill` schema, RLS/ownership
model, and how they will integrate — conceptually — with the existing
`opportunity_match` and `application` tables in later gates. This document
does not modify those tables; it exists so the R1–R7 sequence is built on
a schema everyone has already agreed to.

---

## 1. `resume` table

```sql
create table public.resume (
  id                    uuid primary key default gen_random_uuid(),
  candidate_id          uuid not null references public.candidate(id) on delete cascade,

  label                 text not null check (btrim(label) <> ''),
  target_role_category  text check (target_role_category is null or btrim(target_role_category) <> ''),

  evidence_source_id    uuid references public.evidence_source(id) on delete set null,

  is_active             boolean not null default true,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
```

**Field-by-field reasoning:**

- **`label`** — required, non-empty, e.g. `"Software Development"`,
  `"AI/ML"`. This is the human-facing name shown in the resume-grouped
  feed. No uniqueness constraint per candidate — two resumes named
  identically is a UX nit, not a data-integrity problem, and forcing
  uniqueness would block legitimate cases like archiving an old resume
  and starting a new one with the same label.

- **`target_role_category`** — nullable free text, not a checked enum.
  Unlike `skill.category` (which has an established, closed set:
  `language`/`framework`/`tool`/`domain`/`soft_skill`), there is no
  existing authoritative list of role categories anywhere in the schema
  or codebase. Inventing one now (e.g. `'software_development' |
  'data_science' | 'ai_ml' | ...`) would be exactly the kind of
  speculative enum the project avoids — categories would need to keep
  expanding as candidates use the product, and a closed CHECK constraint
  would mean a migration every time. Free text, matching `label`'s
  validation style, is the conservative choice. **This is an explicit
  decision point** — flagged below in §9 — since if resume-scoped
  matching (Gate R2) later wants to *use* this field programmatically
  (e.g. to pre-filter opportunities by category before scoring), an
  unconstrained free-text field is weaker signal than an enum. Proposal:
  ship free text now; revisit as an enum only if/when Gate R2 shows a
  concrete matching need for it. Until then it is informational/display
  only, same treatment `skill.self_rating` got in Phase 0.

- **`evidence_source_id`** — nullable FK to the existing
  `evidence_source` table, `on delete set null`. Reuses the
  Gate 1a-built upload/Storage infrastructure directly — no new file
  handling code. Nullable because a resume can exist purely as a named
  skill-grouping (e.g. while the candidate is still deciding what to
  upload) before any file is attached. `on delete set null` (not
  cascade) so deleting the underlying evidence file doesn't silently
  delete the resume/skill-grouping itself, matching the precedent set by
  `opportunity_match.promoted_opportunity_id`.

  **Constraint worth naming explicitly:** nothing stops the same
  `evidence_source_id` from being attached to two different `resume`
  rows. This is intentional, not an oversight — a candidate might
  reasonably upload one PDF and tag it under two different role-category
  labels while deciding how to split skills. No uniqueness constraint is
  added here.

- **`is_active`** — boolean, default `true`. This is the archive
  mechanism (§6 below) — not a delete. Matches how the project already
  treats "soft" lifecycle state elsewhere (`opportunity_source.status`
  uses a text enum instead of a boolean, but resume only needs two
  states, so boolean is the simpler correct tool here, not a speculative
  enum for states that don't exist yet).

**Indexes:**

```sql
create index idx_resume_candidate_id on public.resume(candidate_id);
create index idx_resume_candidate_active
  on public.resume(candidate_id, is_active);
create index idx_resume_evidence_source_id
  on public.resume(evidence_source_id) where evidence_source_id is not null;
```

**RLS:** identical ownership-through-candidate subquery pattern used by
every candidate-owned table since `0007_education.sql` (`skill`,
`evidence_source`, `application`, etc.) — select/insert/update/delete, all
gated on `exists (select 1 from candidate c where c.id = resume.candidate_id
and c.auth_user_id = auth.uid())`. Nothing new to design here; it is
copy-and-adapt, per existing convention.

---

## 2. `resume_skill` table

```sql
create table public.resume_skill (
  id          uuid primary key default gen_random_uuid(),
  resume_id   uuid not null references public.resume(id) on delete cascade,
  skill_id    uuid not null references public.skill(id) on delete cascade,

  created_at  timestamptz not null default now(),

  constraint uq_resume_skill unique (resume_id, skill_id)
);
```

- Pure join table — no payload columns. Nothing about a skill changes
  when it's attached to a resume (no per-resume rating override, no
  per-resume notes); it either belongs to that resume's skill set or it
  doesn't. If a future gate wants per-resume skill emphasis or ordering,
  that's an additive column on this table then, not something to
  speculatively add now.
- `unique(resume_id, skill_id)` prevents the same skill being attached
  twice to the same resume. It does **not** prevent the same skill being
  attached to multiple different resumes — that's the entire point of
  the many-to-many model you approved.
- Both FKs `on delete cascade`: deleting a resume drops its skill
  associations (the skills themselves are untouched, only the join
  rows); deleting a skill removes it from any resume it was attached to.
  Neither cascade reaches into `skill` or `resume` themselves.

**Indexes:**

```sql
create index idx_resume_skill_resume_id on public.resume_skill(resume_id);
create index idx_resume_skill_skill_id on public.resume_skill(skill_id);
```

**RLS — this is the one place that needs a slightly different pattern**
than a plain candidate-subquery, because `resume_skill` has no
`candidate_id` column of its own; ownership is two hops away (through
`resume`, which points at `candidate`). Proposed policy shape (same
`exists` idiom, one extra join):

```sql
using (
  exists (
    select 1
    from public.resume r
    join public.candidate c on c.id = r.candidate_id
    where r.id = resume_skill.resume_id
      and c.auth_user_id = auth.uid()
  )
)
```

This still needs a full RLS test suite addition
(`tests/rls/test_resume_ownership.sql`, covering both `resume` and
`resume_skill`) at Gate R1 — cross-candidate isolation is exactly the
kind of thing that needs to be proven against real Postgres, not assumed
because the SQL looks right.

**Insert-path ownership note:** the `with check` on `resume_skill` insert
needs to verify ownership of *both* the `resume_id` and the `skill_id`
being linked — otherwise a malicious insert could try to attach another
candidate's `skill` row (or link into another candidate's `resume`) as
long as *one* of the two IDs happens to be the caller's own. The policy
above only checks `resume_id` ownership; Gate R1 needs a second `exists`
clause checking `skill.candidate_id` ownership too, `and`-ed together.
Flagging this now so it isn't lost between design and implementation.

---

## 3. Lifecycle: active / archived

- `is_active = true` is the default and normal state.
- "Archiving" a resume = `update resume set is_active = false`. Nothing
  else happens automatically:
  - Existing `opportunity_match` rows scored against that resume (once
    Gate R2 exists) are **not** deleted or recomputed — they remain as
    history.
  - Existing `application` rows that used that resume (once Gate R4
    exists) are **not** affected — the FK just continues pointing at a
    now-archived resume, which is correct: "which resume did I use" is a
    historical fact that shouldn't change when the resume's current
    status changes.
  - The batch matching orchestrator (Gate R2) should skip archived
    resumes when generating new daily matches — an explicit filter
    (`is_active = true`) at the orchestrator level, not an RLS-level
    concern.
- No hard delete route is proposed for `resume` in this phase, mirroring
  the precedent set by `application` (no DELETE route at the API layer,
  even though RLS grants the DB-level policy) — archiving preserves
  history; only DB-level cleanup (the RLS delete policy existing "just in
  case," never exposed via a route) covers accidental/duplicate rows.

---

## 4. How resume-scoped matching will work conceptually (Gate R2 preview)

Not built in this gate — described here only so this design doc can be
judged against where it leads.

- `matchEngine.ts` stays untouched, as required. It already takes a
  skill set as input; the orchestrator will call it once per
  `(candidate, resume)` pair instead of once per candidate, passing only
  that resume's linked skills (via `resume_skill`) as the input skill
  set.
- Candidates with **zero** resumes are not blocked — the orchestrator's
  existing candidate-level pass (all of a candidate's skills, no resume
  filter) continues to run unchanged. Resume-scoping is additive, not a
  replacement, until/unless you later decide every candidate must have
  at least one resume.

---

## 5. How this integrates with `opportunity_match` (Gate R2 preview — flagged tension)

**RESOLVED at Gate R2 (0026_opportunity_match_resume.sql): Option 1 below
was chosen** — `opportunity_match` was extended with a nullable
`resume_id`, using two partial unique indexes rather than a separate
table. This section is kept as originally written (the tension it
identifies is real and is exactly what Gate R2 had to solve) — see
`0026_opportunity_match_resume.sql`'s own comments for the resolved
schema and `runMatchingForCandidate.ts`'s comments for the upsert-
mechanics consequence that decision turned out to have (a plain
client-side `.upsert({ onConflict })` cannot target a partial index,
which is why a SQL-side batch-upsert function was needed on top of the
schema change itself — not something this section anticipated, and
worth knowing if this pattern comes up again elsewhere).

This is the one place where the R0 design surfaces a real conflict that
Gate R2 will need to resolve, not paper over:

`opportunity_match` currently has:

```sql
constraint uq_opportunity_match_candidate_source
  unique (candidate_id, opportunity_source_id)
```

— **one match row per candidate per opportunity, full stop.** If Gate R2
adds a nullable `resume_id` column so a distinct score can exist *per
resume* against the same opportunity, this unique constraint has to
change, because Postgres treats `NULL` as distinct-from-itself in unique
indexes — meaning a naive `unique(candidate_id, opportunity_source_id,
resume_id)` would allow unlimited duplicate rows for candidates with no
resume (`resume_id IS NULL` never collides with another `NULL`), silently
breaking the existing "re-matching updates the existing row" guarantee
for exactly the candidates this is supposed to stay backward-compatible
for.

This needs a real decision at Gate R2, options being (not deciding now):
1. Keep the existing constraint as-is for `resume_id IS NULL` rows
   (candidate-level, no resume) via a **partial unique index**
   (`... where resume_id is null`), plus a second full unique index
   `unique(candidate_id, opportunity_source_id, resume_id) where
   resume_id is not null` for the resume-scoped rows.
2. Split resume-scoped matches into their own table entirely
   (`resume_opportunity_match`), leaving `opportunity_match` exactly as
   it is today for the candidate-level pass.

Not resolving this now — just making sure it's visible before Gate R2
starts, since it's a direct consequence of the `resume` schema this
document proposes.

---

## 6. How this integrates with `application` (Gate R4 preview)

**RESOLVED at Gate R4 (0027_application_resume.sql), with one refinement
beyond what this section originally proposed:** `resume_id` is set
**explicitly by the candidate** (POST /applications body, correctable via
PUT) — NOT automatically derived from whichever `opportunity_match` row
had `promoted_opportunity_id` pointing at the claimed opportunity, which
is what this section's original wording ("recording which resume was
used") could be read as implying. The reason: nothing in the schema stops
a candidate from marking more than one resume's match (for the same
opportunity_source) as promoted toward the same claimed `opportunity` row
— `promoted_opportunity_id` isn't unique-constrained across
`opportunity_match` rows — so "the" resume to infer would be genuinely
ambiguous in that case. Explicit and candidate-stated avoids that
ambiguity entirely, at the cost of the frontend (Gate R7) needing to pass
`resume_id` along at apply-time rather than it being inferred for free.

Your refinement is already how `application` is built — nothing to
change:

```sql
constraint uq_application_candidate_opportunity
  unique (candidate_id, opportunity_id)
```

Identity is already `candidate + opportunity`, exactly as you specified.
Gate R4 only needs to **add** a nullable `resume_id` column (`references
resume(id) on delete set null`) recording which resume was used —
it does not touch, and does not need to touch, the existing unique
constraint at all. `on delete set null` (not cascade, not restrict) so
deleting a resume later never deletes or blocks deletion of application
history — the application record survives as "resume used: none / no
longer known," same pattern as `promoted_opportunity_id`.

This also means bulk-apply (Gate R5), even when scoped to one resume,
cannot create a second `application` row for an opportunity that already
has one from a different resume — the existing constraint already
prevents exactly the scenario you described. Nothing new needs
enforcing.

---

## 7. Backward compatibility for candidates with no resume

No candidate is required to create a resume. Concretely:

- `resume` and `resume_skill` are purely additive tables; nothing about
  `skill`, `evidence_source`, `opportunity_match`, or `application`
  changes shape in a way that requires a value here.
- The Gate R2 orchestrator's existing no-resume candidate-level matching
  pass keeps working unchanged (see §4).
- The Gate R3 feed's `resume_id` query param is optional — omitting it
  returns today's existing flat, ungrouped feed.
- The Gate R4 `application.resume_id` column is nullable — applications
  created before a candidate ever makes a resume, or by a candidate who
  never makes one, simply have `resume_id = null` forever, which is a
  valid, permanent, correct state, not a migration gap to backfill.

---

## 8. Migration sequencing

- **`0025_resume.sql`** (Gate R1): `resume` table, `resume_skill` table,
  both sets of RLS policies, both index sets, `tests/rls/
  test_resume_ownership.sql`.
- **`0026_opportunity_match_resume.sql`** (Gate R2): whichever option is
  chosen from §5, applied to `opportunity_match` (or a new
  `resume_opportunity_match` table).
- **`0027_application_resume.sql`** (Gate R4): nullable `resume_id`
  column + FK on `application`.

(Numbers assume `0024_candidate_column_write_guard.sql` remains the most
recent migration in the repo at the time R1 starts — worth re-checking
the migrations directory immediately before R1 in case anything else has
landed in between.)

---

## 9. Explicit decisions — in scope for R0 sign-off vs. deferred

**Decided (per your Gate R0 approval message):**
- Resume = label + optional evidence file + subset of existing skills.
- `target_role_category` included on the table.
- `resume_skill` many-to-many, no skill duplication, `matchEngine.ts`
  untouched.
- No resume-count limit.
- This phase is tracking-only; no auto-submission.
- `application` identity stays `candidate + opportunity`; resume is an
  attribute of the application, not part of what makes it unique.

**Needs your explicit decision as part of R0 sign-off:**
- **`target_role_category` as free text vs. enum** (§1) — proposal is
  free text now, revisit later. Confirm or override.

**Explicitly deferred to their own gates, not decided here:**
- How the `opportunity_match` uniqueness conflict gets resolved (§5) —
  Gate R2.
- Whether `resume_id IS NULL` rows in a future match table represent
  "candidate has no resumes" or "matched at candidate-level regardless of
  resume" as a permanent parallel mode — Gate R2.
- Any fuzzy/duplicate-opportunity detection beyond exact
  `opportunity_id` equality — separate from this plan entirely (already
  tracked as its own deferred item: Gate R6 "real duplicate protection").
- Real form-submission/browser automation — explicitly out of scope per
  your Gate R0 answer, its own future gate if ever pursued.

---

## 10. What Gate R1 will actually touch, if approved

Only: one new migration file (`0025_resume.sql`), one new RLS test file
(`tests/rls/test_resume_ownership.sql`). No existing migration, route,
frontend file, or `matchEngine.ts`/`skillNormalization.ts` touched. Zip
delivered per existing convention, tests/typechecks run for real against
Postgres 16 before anything is reported as passing.
