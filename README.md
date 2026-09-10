# InternshipOS — Phase B2: Wire Daily Queue into GET /today

## What this is

Files for this round. Drop into the matching paths in the repo and merge.

```
api/src/lib/todayView.ts          (modified)
api/src/routes/today.ts           (modified)
api/tests/today.route.test.ts     (modified)
api/tests/todayView.test.ts       (modified)

api/src/lib/dailyQueue.ts         (unmodified — from B1, included for a
                                    self-contained drop; verified
                                    byte-identical to the approved B1
                                    zip, diffed before packaging)
api/tests/dailyQueue.test.ts      (unmodified — from B1, same as above)
```

## What changed

`GET /today` now returns an additive `daily_queue: DailyQueueItem[]`
field, built by calling B1's **unmodified** `buildDailyQueue()` from
inside `buildTodayView()`:

- Fed with this same function's own already-computed `action_required`
  list (not re-derived).
- Fed with the route's existing raw candidate-level (`resume_id IS NULL`)
  `opportunity_match`/`opportunity_source` rows — the exact same rows
  already fetched for `feed_summary` — passed through as two new
  optional `TodayViewInput` fields (`dailyQueueMatches`,
  `dailyQueueSources`). No second query, no second candidate-resolution
  mechanism.
- `[]` when nothing is eligible — never null or omitted.
- Every existing Today field is untouched; this is verified by a test
  that diffs two `buildTodayView()` outputs (with vs. without queue
  inputs) and asserts everything except `daily_queue` is identical.

## What did NOT change

- No new endpoint — only the existing `GET /today` route.
- No persistence — the queue is computed fresh on every request.
- No schema/migration changes.
- No changes to `matchEngine.ts`, `skillNormalization.ts`,
  `dedupFingerprint.ts`, `expireStaleOpportunities.ts`, or the Feed
  route — all consumed read-only.
- No frontend changes.
- No changes to `dailyQueue.ts` itself (B1) — confirmed byte-identical
  to the B1 drop before packaging this round.

## Validation performed before this drop

- `today.route.test.ts` — **22/22 passed** (15 pre-existing + 7 new:
  field presence, action-required item surfaced, opportunity match
  surfaced, cap-at-5, existing-fields-untouched, empty-queue contract,
  candidate isolation).
- `todayView.test.ts` — **43/43 passed** (38 pre-existing + 5 new:
  default-empty, action_required threading, match threading,
  additive-only guarantee, cap-at-5).
- Full backend suite: `npx vitest run` — **701/701 passed** (689
  previous + 12 new), zero regressions.
- `npx tsc --noEmit` — clean on all three configs (`tsconfig.json`,
  `tsconfig.tests.json`, `tsconfig.scripts.json`).
- `git status --short` before packaging showed only the 4 modified files
  above as changed (plus the untouched B1 files as untracked); nothing
  else in the working tree changed. `git diff --stat`: 4 files changed,
  423 insertions(+), 3 deletions(-).

## Next steps (future gates, not in this drop)

- B4: frontend surface for `daily_queue` (Today section or dedicated
  `/queue` page).
- B5 (optional, separate design sign-off): deadline-aware urgency for
  unapplied opportunities.
