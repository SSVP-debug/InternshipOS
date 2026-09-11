# InternshipOS — Phase B5: Deadline-Aware Urgency for Unapplied Opportunities

## What this is

Every file this round touched or depends on, at its current full state
(this drop supersedes the B1–B4 drops for these files). Drop into the
matching paths and merge.

```
api/src/lib/dailyQueue.ts                  (modified — new opportunity_deadline reason)
api/src/lib/opportunityFeed.ts             (modified — deadline_date field, additive)
api/src/lib/todayView.ts                   (modified — exported date helpers + named threshold, now passed to buildDailyQueue)
api/src/routes/opportunity-feed.ts         (modified — deadline_date now selected)
api/src/routes/today.ts                    (unchanged this round — included for completeness)
api/tests/dailyQueue.test.ts               (rewritten — +9 Phase B5 tests)
api/tests/opportunityFeed.test.ts          (modified — +1 deadline_date passthrough test)
api/tests/opportunity-feed.route.test.ts   (modified — +1 route-level deadline_date test)
api/tests/today.route.test.ts              (unchanged this round — included for completeness)
api/tests/todayView.test.ts                (modified — +1 opportunity_deadline integration test)

web/src/lib/api.ts                         (modified — deadline_date + opportunity_deadline type)
web/src/lib/dailyQueue.ts                  (unchanged this round — included for completeness)
web/src/lib/navBadges.ts                   (unchanged this round — included for completeness)
web/src/pages/today.ts                     (modified — renders opportunity_deadline items)
web/src/pages/opportunityFeed.ts           (unchanged this round — included for completeness)
web/src/style.css                          (modified — one new pill modifier, reused color tokens)
web/tests/dailyQueue.test.ts               (modified — +2 opportunity_deadline coverage)
web/tests/navBadges.test.ts                (modified — fixture fix for the new required field)
```

## What changed

An opportunity the candidate has **not yet applied to** now gets pulled
into the Daily Queue as urgent when its own `opportunity_source.deadline_date`
is close — closing the gap the original Phase B audit flagged (P1, item 3)
and B1 explicitly deferred as "B5."

- **New membership rule** (`lib/dailyQueue.ts`): an already-eligible
  (untriaged, unapplied, active) match becomes `opportunity_deadline`
  instead of `match` when its deadline is `0 ≤ days_until_deadline ≤ 3`
  — the exact same `3`-day threshold `action_required` already uses for
  application deadlines (`ACTION_REQUIRED_DEADLINE_DAYS`, exported from
  `todayView.ts`, not a new number).
- **Past-due deadlines are excluded, not flagged urgent** — an unapplied
  opportunity whose deadline already passed is simply moot; it stays a
  plain `match`, never `opportunity_deadline`.
- **Merged urgency tier** — `opportunity_deadline` items are sorted
  together with `action_required` items by days-until (not a separate,
  lower-priority tier below them).
- **No schema/migration change** — `opportunity_source.deadline_date`
  already existed; this only starts selecting it
  (`OPPORTUNITY_SOURCE_COLUMNS`) and passing it through display types.
- **Frontend**: Today renders `opportunity_deadline` items with the same
  urgent-border/due-date-tab treatment as `action_required` items, a new
  "Deadline approaching" pill, and the exact same Save/Dismiss/Priority/
  Start-application actions as an ordinary `match` — no new action type.

## What did NOT change

- No migration.
- `matchEngine.ts`, `skillNormalization.ts`, `dedupFingerprint.ts`,
  `expireStaleOpportunities.ts` — confirmed empty diff via
  `git diff --stat` against each before packaging.
- A3.1 score floor / A3.2 expiry / A3.3 dedup — reused unmodified via
  `buildOpportunityFeed()`, not re-implemented.
- No new endpoint, no persistence, no new application states, no
  auto-apply.

## Validation performed before this drop

- `api/tests/dailyQueue.test.ts` — **28/28 passed** (19 pre-B5 + 9 new).
- `api/tests/opportunityFeed.test.ts` — **31/31** (+1).
- `api/tests/todayView.test.ts` — **44/44** (+1).
- `api/tests/opportunity-feed.route.test.ts` — **41/41** (+1).
- Full backend suite: **713/713 passed**, zero regressions.
- Backend typecheck: all three configs (`tsconfig.json`,
  `tsconfig.tests.json`, `tsconfig.scripts.json`) clean.
- `web/tests/dailyQueue.test.ts` — **13/13** (+2).
- Full frontend suite: **54/54 passed**.
- Frontend typecheck (`tsconfig.json`, `tsconfig.tests.json`) clean;
  production build succeeded (69 modules, no errors).
- `git diff --stat` against `matchEngine.ts`, `skillNormalization.ts`,
  `dedupFingerprint.ts`, `expireStaleOpportunities.ts`, and
  `supabase/migrations/` was empty before packaging.

## Status

With B5, every item identified in the original Phase B audit — including
both explicitly-deferred follow-ups (nav badges and this gate) — is now
implemented.
