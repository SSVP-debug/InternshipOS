# A3.2 — Opportunity Freshness & Expiry

Drop-in delivery for the approved A3.2 implementation gate. Copy these files
into your working tree at the matching paths, overwriting the existing ones.
No database migration, no new files outside what's listed below.

## What changed

**New file**
- `api/src/lib/ingestion/expireStaleOpportunities.ts` — the sole writer of
  `opportunity_source.status = 'expired'`. Runs one deterministic SQL-level
  sweep: `status = 'active' AND last_seen_at < now() - 14 days` →
  `status = 'expired'`. Strict `<`, idempotent, never touches `removed`.

**Modified**
- `api/src/lib/ingestion/types.ts` — added `SweepSummary` and an additive
  `sweep: SweepSummary` field on `IngestionSummary`. Nothing existing removed
  or renamed.
- `api/src/lib/ingestion/runIngestion.ts` — calls the sweep once, after every
  adapter has run, gated by the ingestion-outage guard: the sweep only runs
  if **at least one source actually wrote something** (`inserted > 0` or
  `updated > 0`) this run. This is deliberately **not** `fetched > 0` — a
  source can successfully fetch data and still write nothing at all (every
  listing filtered out downstream, or every upsert failing outright — bad
  service-role key, table unreachable, etc.), in which case `last_seen_at`
  never actually advances for a single row even though the fetch "succeeded."
  Gating on `fetched > 0` would have let the sweep run believing the catalog
  was refreshed when it wasn't. A partial run (one source down, one source
  writing successfully) does **not** trip the guard — the sweep still runs,
  same as normal daily operation; only a run where nothing was written
  anywhere skips it.
- `api/scripts/ingest.ts` — logs the sweep's outcome (`expired: N` or the
  skip reason) alongside the existing per-source summary. No change to the
  script's exit-code logic.
- `api/tests/runIngestion.test.ts` — the shared mock Supabase client now also
  supports `.update().eq().lt().select()` (needed for the sweep call) and an
  optional `upsertError` (needed for the guard-fix regression tests below);
  added 8 new tests covering the sweep running on success/partial-failure,
  being skipped on total outage / no adapters / all-zero runs, sweep error
  propagation, and — the specific gap fixed in this revision — being skipped
  when a source fetches data but writes nothing (either every listing gets
  filtered out, or every write fails outright).

## Outage-guard correction (this revision)

The first pass of this guard used `fetched > 0 || inserted > 0 || updated > 0`.
That was too permissive: `fetched > 0` only means the adapter's network call
succeeded — it says nothing about whether any row's `last_seen_at` actually
advanced. A source can fetch real data and still write nothing (every
listing filtered out by relevance/normalization checks downstream, or every
upsert failing outright), and in both cases the guard would have let the
sweep run believing the catalog had just been refreshed when nothing was
actually refreshed. The guard now checks `inserted > 0 || updated > 0` only
— the two new regression tests (`fetched > 0, nothing written` via an empty
`listings` array, and `fetched > 0, every write fails` via a forced
`upsertError`) both assert the sweep stays skipped in exactly that scenario.

**New test file**
- `api/tests/expireStaleOpportunities.test.ts` — 6 tests: threshold constant,
  correct query shape (`status`/`last_seen_at`/cutoff value), correct count
  reporting, zero-result case, non-throwing DB-error handling, and cutoff
  computed relative to an injectable `now` (not wall-clock time).

## What did NOT change

- No database migration. `opportunity_source.status` and `.last_seen_at`
  already existed with the right semantics (`0022_opportunity_intelligence_foundation.sql`);
  `'expired'` was already a legal enum value, just never written before.
- `matchEngine.ts` and `skillNormalization.ts` — untouched, not read by any
  of the new/changed code.
- `Feed` (`opportunity-feed.ts`, `opportunityFeed.ts`) and `Today`
  (`today.ts`, `todayView.ts`) — untouched. They already filter
  `status = 'active'` in three places; those filters simply become
  meaningful now that `expired` rows can exist. Verified via the existing
  `opportunityFeed.test.ts` case at line 107 (`status: "expired"` is dropped
  from the feed), which already passed before this change and still does.
- `removed` — never written. Reserved for a future explicit-signal phase per
  the approved design; out of scope here.

## Verification run in this delivery

- `npx vitest run` — **670/670 passing** (up from the 617 baseline: +53 from
  the new sweep test file and the new `runIngestion.test.ts` cases).
- `npx tsc --noEmit` — clean.
- `npm run typecheck:scripts` — clean.
- `npm run typecheck:tests` — clean.
- `git diff --name-only` confirms only the 4 modified files + 2 new files
  listed above; nothing else touched, `supabase/migrations/` untouched.

Postgres/RLS was not available in this sandbox (same caveat as prior
gates) — this change doesn't touch RLS policies or table structure at all,
so no RLS re-verification is needed, but running the existing `npm test`
suite plus a manual `npm run ingest` against a staging Supabase project
before merging to production is still recommended, per the project's
testing standard.

## One behavior worth knowing

Because `writeOpportunitySource.ts` already force-sets `status: 'active'`
and bumps `last_seen_at` on every successful upsert (including updates to
existing rows), a listing that goes stale, gets marked `expired`, and then
genuinely reappears in a later ingestion run will automatically flip back to
`active` with no special-casing needed — this was already true before A3.2
and required no change.
