# InternshipOS — A3.3 Opportunity Quality (dedup-aware matching + source quality)

Implements A3.3.1, A3.3.2, A3.3.3 as approved after the two-pass design review
(initial audit → revised design after the "metadata only doesn't solve
anything" correction). Deadline handling (§7 of the revised design) was
confirmed as **NO CHANGE** — neither Adzuna nor RemoteOK publish deadlines,
and nothing invents one.

Verified before packaging: **696/696 backend tests pass** (670 pre-existing +
26 new), and all three typecheck configs (`tsconfig.json`,
`tsconfig.scripts.json`, `tsconfig.tests.json`) are clean.

---

## What changed

### A3.3.1 — Dedup-aware matching (the real fix)

**File:** `api/src/lib/matching/runMatchingForCandidate.ts`

Previously, `runMatchingForCandidate` called `matchCandidate()` and wrote an
`opportunity_match` row for **every** active `opportunity_source` row,
including when two rows represent the same real-world posting (ingested from
both Adzuna and RemoteOK, or a repost under a new `source_ref`). That cost
compounds daily and multiplies by `1 + active-resume-count` per candidate
(`runMatchingForActiveCandidates.ts`).

This now groups the freshly-loaded **active** rows by the same, already-
shipped, already-tested `buildDedupKey(title, company, location)` from
`opportunityFeed.ts` (imported, not reimplemented — same conservative key
used for feed collapsing and apply-time dedup), and only matches one
representative per group (lowest `opportunity_source_id`, a deterministic
but otherwise meaningless tie-break — score-based selection isn't available
yet at this point in the pipeline).

**No schema change, no persisted key.** Grouping is recomputed fresh from
whatever is `status = 'active'` on every run, which is what makes it
self-healing around A3.2's 14-day freshness expiry with zero changes to that
logic: if today's representative later expires, it just drops out of the
`status = 'active'` filter, and the remaining active duplicate becomes the
representative on the next run automatically.

`title`, `company`, `location` were added to the query's column list
(`OPPORTUNITY_SOURCE_COLUMNS`) purely to support this grouping —
`matchEngine.ts` still never sees them and is completely untouched.

`RunMatchingSummary.opportunitiesEvaluated` now reports the number of rows
actually matched (post-grouping), not the raw active-row count — documented
inline as a deliberate, disclosed change to what the field means. No
consumer of this field (console reporting only, in `run-matching.ts`)
depends on the old raw count.

**Known, accepted transitional limitation** (documented in the file itself):
an `opportunity_match` row that already existed for a non-representative
row before this shipped simply stops being refreshed — it isn't deleted.
Feed/Today's own `collapseDuplicateSources` may show that stale row's score
for a while if it's currently higher than the fresh representative's, until
it's cleaned up. No automatic cleanup is performed (deleting rows was
explicitly out of scope). This does not affect what title/company/location
the candidate sees, since both rows describe the same posting by definition.

### A3.3.2 — Persist `source_name`

**Files:** `supabase/migrations/0029_opportunity_source_name.sql`,
`api/src/lib/ingestion/writeOpportunitySource.ts`

Adds a nullable `opportunity_source.source_name` column. Previously
`CanonicalListing.source_name` ("adzuna"/"remoteok") was only ever consumed
one-way by `computeDedupFingerprint` — there was no way to query which
adapter produced a given row at all (`source_type` is a coarse,
adapter-shared category). Nullable, not backfilled — existing rows get
`source_name = NULL`; attribution starts from the next ingestion run. Purely
descriptive: nothing reads it back yet.

### A3.3.3 — URL validation at ingestion

**Files:** `api/src/lib/ingestion/urlValidation.ts` (new),
`api/src/lib/ingestion/writeOpportunitySource.ts`

Neither adapter validated `application_url`/`source_url` before — both pass
the raw API value straight through. `isWellFormedUrl()` is a pure,
network-free check (`new URL()` parse + http/https scheme only — no
liveness/reachability check, per the hard constraint against network-
dependent link checking). `coerceToWellFormedUrl()` returns the value
unchanged if well-formed, otherwise `null` — a malformed URL never rejects
the rest of the listing, consistent with this project's existing "null
means unstated, never a hard failure" discipline.

---

## Tests added (26 new)

- `api/tests/runMatchingForCandidate.test.ts` — 5 new tests under
  `describe("A3.3.1: dedup-aware matching")`: duplicate collapsing, non-
  collapse of genuinely distinct title/company/location, **self-healing on
  expiry** (the load-bearing correctness property for the whole design),
  and resume-scoped passes.
- `api/tests/writeOpportunitySource.test.ts` — 6 new tests: `source_name`
  persistence (two adapters), well-formed URL pass-through, malformed
  `application_url`/`source_url` coercion to `null`, and null-input
  handling.
- `api/tests/urlValidation.test.ts` — 14 new tests covering both exported
  functions.
- `api/tests/adzunaAdapter.test.ts` / `api/tests/remoteokAdapter.test.ts` —
  1 new named test each, explicitly pinning "deadline_date is always null"
  (previously only implied by the broader shape-mapping test).

Two existing fixtures (`UNENRICHED_OPPORTUNITY_ROW` in
`runMatchingForCandidate.test.ts` and `runMatchingForActiveCandidates.test.ts`)
were updated to include `title`/`company`/`location`, since the query now
selects them — this is why those two files show as modified beyond the new
`describe` block.

---

## How to verify after merging

```bash
cd api
npm ci
npx vitest run                       # expect 696/696
npx tsc --noEmit -p tsconfig.json
npm run typecheck:scripts
npm run typecheck:tests
```

Then apply the migration (`supabase/migrations/0029_opportunity_source_name.sql`)
against your Supabase project in the normal way.

---

## Rollback

- **A3.3.1** requires no migration rollback — revert
  `runMatchingForCandidate.ts` to remove the grouping step and re-run
  matching for all active rows to restore full per-row matching. Nothing
  was ever deleted or merged, so this is a pure code revert.
- **A3.3.2 / A3.3.3** — drop the `source_name` column
  (`alter table public.opportunity_source drop column source_name;`) and/or
  revert `writeOpportunitySource.ts`. Both are purely additive; reverting
  either has no effect on the other.

---

## Explicitly not implemented (per the approved design)

- `dedup_group_key` persisted column — rejected; in-memory grouping at
  matching time already solves the real problem without a new column.
- Skip-duplicate-ingestion (Strategy B) — rejected; risks losing provenance
  and freshness signal.
- Canonical/alias table (Strategy C) — rejected; not justified by the
  actual traced cost, would be a real schema redesign.
- Deadline extraction of any kind — no source data exists to act on.
- Spam/reputation scoring — no repository evidence justifies it.
- Network-based link-liveness checking — explicitly excluded.

`matchEngine.ts` and `skillNormalization.ts` are not touched by any file in
this round.
