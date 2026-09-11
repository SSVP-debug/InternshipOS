# InternshipOS — Phase B follow-up: Nav Badge Polish (P2)

## What this is

A small, optional follow-up to Phase B (flagged as P2 in the original
Phase B audit — "cheap and low-priority, cut if time-constrained").
Frontend-only. Drop into the matching paths and merge.

```
web/src/lib/navBadges.ts         (new)
web/src/pages/today.ts           (modified — now includes both the
                                   Phase B3 Daily Queue section AND this
                                   round's badge wiring; this is the full
                                   current file, supersedes the B3 drop)
web/src/pages/opportunityFeed.ts (modified — badge wiring only)
web/tests/navBadges.test.ts      (new)
```

## What changed

`shell.ts`'s `renderShell()` has always accepted an optional `badges`
param, but every call site passed the default `{}` — no sidebar nav item
ever showed a count. This gate wires two of them up:

- **Today** nav link now shows a badge = the live Daily Queue length
  (`todayBadgeCount`), re-computed on every `draw()` so it stays in sync
  as queue items are actioned (saved/dismissed/applied).
- **Feed** nav link now shows a badge = the count of untriaged,
  not-yet-promoted, non-ineligible matches (`feedBadgeCount`) — the
  *exact same definition* `api/src/lib/todayView.ts`'s `summarizeItems()`
  already uses for `feed_summary.new_matches_count`, reproduced on the
  frontend (not re-derived differently) only because the Feed page's own
  fetch returns raw items, not that precomputed count.
- A badge is **absent** (not shown as "0", not stale) whenever its count
  isn't known — e.g. Today's badge doesn't appear while browsing Feed,
  since that would require fetching Today's own data from a page that
  isn't Today. No new API calls, no cross-page shared state.
- `0` is never rendered as a badge (`shell.ts`'s existing
  `badgeCount ? ... : null` already treated 0 as falsy/hidden) — kept
  as-is.

## What did NOT change

- No backend changes at all — confirmed via `git diff --stat` that only
  `web/` files changed this round.
- No new API fields, no new endpoints.
- No changes to `api/src/lib/dailyQueue.ts`, matching/scoring/expiry
  logic, or Feed ranking.
- No new nav items, no redesign of the sidebar — only badges on two
  existing links, using the CSS class (`.nav__badge`) that was already
  defined in `style.css` but unused until now.

## Validation performed before this drop

- `web/tests/navBadges.test.ts` — **5/5 passed**.
- Full frontend suite: `npx vitest run` (web) — **52/52 passed** (47
  pre-existing + 5 new), zero regressions.
- Frontend typecheck: `tsconfig.json` and `tsconfig.tests.json` — both
  clean.
- Frontend production build: `npm run build` — succeeded (69 modules, no
  errors).
- Backend full suite (safety check, no backend files changed):
  **701/701 passed**.
- `git diff --stat -- web/` (this round, on top of the already-reported
  B3 state): `web/src/lib/api.ts` unchanged this round;
  `web/src/pages/opportunityFeed.ts` (+/-10 lines),
  `web/src/pages/today.ts` (cumulative B3+badges diff vs. pre-B3
  baseline: 340 insertions/142 deletions). `web/src/lib/navBadges.ts` and
  `web/tests/navBadges.test.ts` are new/untracked.

## Status

With this, all of the Phase B audit's IN-SCOPE items plus the P2
nav-badge polish are done. The one remaining, explicitly-deferred item
is **B5 — deadline-aware urgency for unapplied opportunities**, which
was scoped as a separate future gate from the start, not part of Phase B
proper.
