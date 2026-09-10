# InternshipOS — Phase B1: Daily Queue Core

## What this is

Two new files only — nothing existing was modified. Drop these into the
matching paths in the repo and merge.

```
api/src/lib/dailyQueue.ts       (new)
api/tests/dailyQueue.test.ts    (new)
```

## What it does

Pure, deterministic derivation of the Daily Queue — "what should this
student do next?" — per the approved Phase B audit / B1 design brief.

- Merges the caller's existing `action_required` items (todayView.ts,
  unmodified) with untriaged opportunity matches, produced by calling the
  **unmodified** `buildOpportunityFeed()` (opportunityFeed.ts) internally.
  That single call is what gives the queue A3.1's score floor, A3.2's
  active-only/expiry filtering, and A3.3's duplicate-source collapsing —
  none of it re-implemented here.
- Orders action-required items first (by urgency), then opportunities by
  existing `match_score` descending — no new scoring model.
- Deduplicates across both inputs and caps the result at 5 items
  (`DAILY_QUEUE_CAP`).
- Every returned item carries a `reason: "action_required" | "match"`
  plus its full underlying payload, so a later frontend layer can explain
  why it's in the queue without guessing.

No I/O, no randomness, no persistence — a pure function, same discipline
as `todayView.ts` / `opportunityFeed.ts`.

## Explicitly NOT included in this drop (by design)

- No API route (no `GET /daily-queue` or similar).
- No frontend changes.
- No schema/migration changes.
- No changes to `matchEngine.ts`, `skillNormalization.ts`,
  `dedupFingerprint.ts`, or any A3.1/A3.2/A3.3 behavior — all consumed
  read-only.
- No resume-scoping, AI recommendations, notifications, auto-apply, new
  opportunity states, or deadline inference for unapplied opportunities
  (that's the separate, future B5 gate).

## Validation performed before this drop

- `npx vitest run tests/dailyQueue.test.ts` — **19/19 passed** (covers
  empty input, action-required priority, score ordering, cap/truncation,
  untriaged filtering for saved/dismissed/promoted, expired/removed
  source filtering, score-floor boundary, dedup across and within
  inputs, deterministic tie-breaks, and the reason/payload contract).
- `npx vitest run` (full backend suite) — **689/689 passed** (670
  pre-existing + 19 new), zero regressions.
- `npx tsc --noEmit` — clean on all three configs (`tsconfig.json`,
  `tsconfig.tests.json`, `tsconfig.scripts.json`).
- `git status --short` before packaging showed only these two files as
  untracked; nothing else in the working tree changed.

## Next steps (future gates, not in this drop)

- B3: wire `buildDailyQueue()` into `GET /today` (or a new endpoint).
- B4: frontend surface (Today section or dedicated `/queue` page).
- B5 (optional, separate design sign-off): deadline-aware urgency for
  unapplied opportunities.
