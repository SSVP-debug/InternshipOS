# InternshipOS — Phase B3: Student-Facing Daily Queue

## What this is

Frontend-only files for this round. Drop into the matching paths in the
repo and merge. No backend files are included because none changed —
`api/src/lib/dailyQueue.ts` (B1) and the `/today` route/view (B2) are
untouched, confirmed byte-identical to the approved B2 drop before
packaging.

```
web/src/lib/api.ts             (modified — new DailyQueueItem type + daily_queue field)
web/src/lib/dailyQueue.ts      (new — pure display-logic helpers)
web/src/pages/today.ts         (modified — "What should I do next?" section)
web/tests/dailyQueue.test.ts   (new)
```

## What changed

Today's page now renders the API's `daily_queue` field as its first,
most prominent section:

- **Heading:** "What should I do next?" / "A short list of the most
  useful things to act on today." — no AI/automation/certainty language.
- **`action_required` items** reuse the existing `actionStub()` renderer
  unchanged (same look as "Needs your attention" elsewhere on the page).
- **`match` items** reuse the existing Feed actions exactly —
  `updateOpportunityMatchInbox()` (Save/Dismiss/Priority) and
  `bulkApply()` (Start application) — no new endpoints, no new actions,
  no auto-apply.
- **Order is authoritative:** the frontend renders `daily_queue` exactly
  as received — no client-side re-sort, re-filter, or re-cap (the API
  already caps at 5).
- **Empty state** ("You're all caught up...") is explicitly distinguished
  from an **"unavailable" state** (queue field missing/malformed) via a
  new pure helper, `classifyDailyQueueState()` — the honest empty-state
  copy is never shown when the truth is "we don't know."
- Local actions (save/dismiss/apply) remove the affected item from the
  visible queue immediately, mirroring the backend's own membership rule
  (no longer `inbox_status: "new"`).

## What did NOT change

- No new route (`/daily-queue` was not created).
- No new API endpoint.
- No schema/migration changes.
- No changes to `api/src/lib/dailyQueue.ts`, `matchEngine.ts`,
  `skillNormalization.ts`, `dedupFingerprint.ts`,
  `expireStaleOpportunities.ts`, or Feed ranking — all confirmed
  untouched.
- No new application states, no auto-apply, no AI-generated
  explanations — every "why" shown is a literal existing signal
  (deadline/follow-up reason, or "New match").

## A note on frontend test coverage

This repo's `web/vitest.config.ts` is explicitly node-only with no
jsdom/DOM-rendering capability (documented in that file's own header
comment as a deliberate, separate decision the repo hasn't made — no
existing page, including the pre-B3 `today.ts` or `opportunityFeed.ts`,
has DOM-render tests either). So the new tests cover everything that
*is* pure and testable under the existing setup — `classifyDailyQueueState`,
`dailyQueueItemKey`, order preservation, `formatMatchMeta` — while actual
DOM wiring was verified via a clean typecheck and production build
rather than introducing new test infrastructure outside this gate's scope.

## Validation performed before this drop

- `web/tests/dailyQueue.test.ts` — **11/11 passed**.
- Full frontend suite: `npx vitest run` (web) — **47/47 passed** (36
  pre-existing + 11 new), zero regressions.
- Frontend typecheck: `tsconfig.json` and `tsconfig.tests.json` — both
  clean.
- Frontend production build: `npm run build` — succeeded (68 modules,
  no errors).
- Backend full suite (safety check, no backend files changed): **701/701
  passed**.
- Backend typecheck (safety check): all three configs clean.
- `git diff --stat -- web/`: 2 files changed, 322 insertions(+), 139
  deletions(-); `web/src/lib/dailyQueue.ts` and
  `web/tests/dailyQueue.test.ts` are new/untracked. No other files in the
  working tree changed this round.

## Next steps (future gates, not in this drop)

- B5 (optional, separate design sign-off): deadline-aware urgency for
  unapplied opportunities feeding into the queue.
