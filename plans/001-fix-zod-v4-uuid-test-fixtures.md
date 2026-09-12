# Plan 001 — Fix zod v4 UUID validation regression in test fixtures

**Written against commit:** `e311775` (branch: `master`)
**Status:** DONE (executed and verified 2026-09-12 — see `fixed-tests/001-diff.patch`)

## Why this matters

Dependabot merged `zod` 3.25.76 → 4.5.4 into `master` on 2026-09-10
(`b16c5e7`, merged via `c7159ca`). Zod v4 tightened `z.string().uuid()`
to require an RFC 4122–valid version nibble (`1`–`5` as the first
character of the third hyphen-group) and variant nibble (`8`, `9`, `a`,
or `b` as the first character of the fourth hyphen-group). Zod v3 used a
looser regex that did not enforce this.

Many test files across the backend use hand-written placeholder UUIDs
like `11111111-1111-1111-1111-111111111111` — valid-looking, but not
RFC 4122–compliant (version nibble `1`, variant nibble `1`, both out of
the allowed ranges). Under zod v4 these now fail `.safeParse()` wherever
a route or schema validates them with `z.string().uuid()`
(`api/src/lib/schemas.ts`), which is most places `opportunity_id`,
`resume_id`, `skill_id`, `evidence_source_id`, or an array of
`opportunity_match_ids` gets validated.

**Current impact, confirmed by actually running the suite on this
commit:** `npx vitest run` inside `api/` reports **59 failed / 682
passed / 741 total**, across 8 test files. `npx tsc --noEmit` is clean —
this is purely a runtime validation regression, not a type error, which
is why the type-check step in CI would not have caught it.

This is not a hypothetical — CI (`.github/workflows/ci.yml`) runs
`npm test` on every push/PR to `main`, so this should currently be
showing red on `master` unless something else is masking it. It also
means `PROGRESS.md`'s "Full backend suite: 713/713 passed, zero
regressions" line (written in the README's B5 drop, before this bump
was merged) no longer describes the current state of `master` — that
line will need a follow-up correction once this plan lands, but that
correction is out of scope for this plan (see "Out of scope" below).

**Why this is a test-fixture bug, not a production bug:** every UUID
your running application actually generates comes from Postgres
(`gen_random_uuid()` / `uuid_generate_v4()` in the Supabase migrations),
which always produces RFC 4122–compliant v4 UUIDs. The stricter
validation is *correct* and matches what real data looks like — it's
only the tests' hand-written placeholder values that were never
compliant. **Do not weaken the validation to work around this.** Fix the
fixtures, not the schema.

## Evidence this plan is built on

Confirmed by running `cd api && npx tsx` against the installed
`zod@4.5.4`:
```
"11111111-1111-1111-1111-111111111111" → safeParse fails (version/variant nibble invalid)
"550e8400-e29b-41d4-a716-446655440000" → safeParse succeeds (valid v4 UUID)
```

The repo already contains a correct exemplar to copy the *pattern* from —
`api/tests/claim.schema.test.ts:4`:
```ts
const VALID_UUID = "11111111-1111-4111-8111-111111111111";
```
Note the third group is `4111` (starts with valid version nibble `4`)
and the fourth group is `8111` (starts with valid variant nibble `8`).
That file was never broken by the zod bump, because its placeholder was
written compliant from the start. This plan makes every other file
match that same convention: keep each fixture's original repeated digit
for readability, but force position 15 (first char of the 3rd group) to
`4` and position 20 (first char of the 4th group) to `8`.

## Files in scope

Only test files. No source file under `api/src/` needs to change —
`api/src/lib/schemas.ts`'s `z.string().uuid()` calls are correct as-is
and must not be touched.

1. `api/tests/application.route.test.ts`
2. `api/tests/application.schema.test.ts`
3. `api/tests/opportunity-feed.route.test.ts`
4. `api/tests/opportunity.schema.test.ts`
5. `api/tests/resume.route.test.ts`
6. `api/tests/resume.schema.test.ts`

## Files explicitly out of scope

- `api/src/**` — no source change. If you find yourself wanting to edit
  `schemas.ts`, stop — that means you've misdiagnosed the problem.
- `api/tests/claim.schema.test.ts`, `api/tests/claim.test.ts`,
  `api/tests/runMatchingForActiveCandidates.test.ts`,
  `api/tests/runMatchingForCandidate.test.ts` — these already use
  compliant placeholders (e.g. `11111111-1111-4111-8111-111111111111`)
  and are not in the failing set. Leave them untouched.
- `PROGRESS.md` / `README.md` — updating the stale "713/713 passed"
  claim is a documentation follow-up, not part of this plan. Don't edit
  these files here.
- The two `adzunaAdapter.test.ts` / `remoteokAdapter.test.ts` failures
  are a **different, unrelated** root cause (stale hardcoded fixture
  counts) — that's Plan 002. Don't fix them here even though they show
  up in the same `vitest run` output.

## Steps

### Step 1 — Reproduce and confirm the baseline

```
cd api
npm ci
npx vitest run 2>&1 | tail -5
```
Expected: `8 failed | 44 passed (52)` test files (or similar), with
`59 failed | 682 passed (741)` tests total. If your numbers differ
significantly, STOP and report back — the codebase may have moved since
this plan was written (check `git log -3` against the commit this plan
is stamped against, above).

### Step 2 — Fix `api/tests/resume.schema.test.ts`

Line 4, exact string replace:
```diff
- const VALID_UUID = "11111111-1111-1111-1111-111111111111";
+ const VALID_UUID = "11111111-1111-4111-8111-111111111111";
```
Verify: `npx vitest run tests/resume.schema.test.ts` → expect `17/17` passing (was `15/17`).

### Step 3 — Fix `api/tests/resume.route.test.ts`

Lines 6–8, exact string replace (three separate consts, same file):
```diff
- const CANDIDATE_ID = "00000000-0000-0000-0000-000000000000";
- const RESUME_ID = "11111111-1111-1111-1111-111111111111";
- const SKILL_ID = "22222222-2222-2222-2222-222222222222";
+ const CANDIDATE_ID = "00000000-0000-4000-8000-000000000000";
+ const RESUME_ID = "11111111-1111-4111-8111-111111111111";
+ const SKILL_ID = "22222222-2222-4222-8222-222222222222";
```
`CANDIDATE_ID` is included even though it may not currently be routed
through `z.string().uuid()` — fixing it now is free and prevents this
same bug from resurfacing silently if a future change starts validating
it.
Verify: `npx vitest run tests/resume.route.test.ts` → all tests in this file passing.

### Step 4 — Fix `api/tests/application.route.test.ts`

Lines 69–71:
```diff
- const VALID_UUID = "11111111-1111-1111-1111-111111111111";
- const OPP_UUID = "22222222-2222-2222-2222-222222222222";
- const RESUME_UUID = "33333333-3333-3333-3333-333333333333";
+ const VALID_UUID = "11111111-1111-4111-8111-111111111111";
+ const OPP_UUID = "22222222-2222-4222-8222-222222222222";
+ const RESUME_UUID = "33333333-3333-4333-8333-333333333333";
```
Verify: `npx vitest run tests/application.route.test.ts` → all tests in this file passing.

### Step 5 — Fix `api/tests/application.schema.test.ts`

Three separate literals in this file (no shared const — check each
occurrence individually, don't assume a single find-replace catches
all):

Line 8:
```diff
- const validOpportunityId = "11111111-1111-1111-1111-111111111111";
+ const validOpportunityId = "11111111-1111-4111-8111-111111111111";
```
Line 62:
```diff
-      resume_id: "22222222-2222-2222-2222-222222222222",
+      resume_id: "22222222-2222-4222-8222-222222222222",
```
Line 111:
```diff
-    const result = ApplicationUpdateRequestSchema.safeParse({ resume_id: "22222222-2222-2222-2222-222222222222" });
+    const result = ApplicationUpdateRequestSchema.safeParse({ resume_id: "22222222-2222-4222-8222-222222222222" });
```
Verify: `npx vitest run tests/application.schema.test.ts` → all passing.

### Step 6 — Fix `api/tests/opportunity-feed.route.test.ts`

This file has UUIDs in three different describe blocks. **Only fix the
ones inside the failing blocks** — leave the `GET /opportunity-feed`
block (lines ~179–484, containing `RESUME_ID = "88888888-..."` at line
366 and `RESUME_A = "99999999-..."` at line 435) untouched; those aren't
validated through `z.string().uuid()` in that code path and aren't part
of the failing set — changing them risks an unrelated, unreviewed diff.

Line 77 (inside the `PATCH /opportunity-matches/:id/inbox` block, or
above it as a shared const — check its actual scope before editing):
```diff
- const MATCH_ID = "11111111-1111-1111-1111-111111111111";
+ const MATCH_ID = "11111111-1111-4111-8111-111111111111";
```
Line 597 (inside `PATCH /opportunity-matches/:id/inbox`):
```diff
-   const OWNED_OPPORTUNITY_ID = "22222222-2222-2222-2222-222222222222";
+   const OWNED_OPPORTUNITY_ID = "22222222-2222-4222-8222-222222222222";
```
Lines 684–688 (inside the `POST /opportunity-matches/bulk-apply (Gate R5)` block):
```diff
- const SOURCE_A_ID = "aaaaaaaa-0000-0000-0000-000000000001";
- const SOURCE_B_ID = "aaaaaaaa-0000-0000-0000-000000000002";
- const MATCH_A_ID = "bbbbbbbb-0000-0000-0000-000000000001";
- const MATCH_B_ID = "bbbbbbbb-0000-0000-0000-000000000002";
- const RESUME_ID = "cccccccc-0000-0000-0000-000000000001";
+ const SOURCE_A_ID = "aaaaaaaa-0000-4000-8000-000000000001";
+ const SOURCE_B_ID = "aaaaaaaa-0000-4000-8000-000000000002";
+ const MATCH_A_ID = "bbbbbbbb-0000-4000-8000-000000000001";
+ const MATCH_B_ID = "bbbbbbbb-0000-4000-8000-000000000002";
+ const RESUME_ID = "cccccccc-0000-4000-8000-000000000001";
```
Note: there are two different `RESUME_ID` consts in this file at
different scopes (line 366 in the block you're *not* touching, and line
688 in the block you *are*). Confirm you're editing the one inside the
`Gate R5` block only — check the line number, not just the variable
name, before editing.

Verify: `npx vitest run tests/opportunity-feed.route.test.ts` → all
tests in the `PATCH /opportunity-matches/:id/inbox` and
`POST /opportunity-matches/bulk-apply (Gate R5)` blocks passing; the
`GET /opportunity-feed` block's test count and pass/fail state
unchanged from baseline.

### Step 7 — Fix `api/tests/opportunity.schema.test.ts`

This one is a generator function, not a flat literal — around line 126:
```diff
- const id = (n: number) => `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`;
+ const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
```
Verify: `npx vitest run tests/opportunity.schema.test.ts` → all passing,
including "accepts a single opportunity_match_id" and "accepts up to 20
opportunity_match_ids".

### Step 8 — Full verification loop

```
cd api
npx vitest run
npx tsc --noEmit -p tsconfig.json
npm run typecheck:scripts
npm run typecheck:tests
```
Expected: **0 failed** in vitest, restricted to this plan's scope — you
should go from `59 failed | 682 passed (741)` to `4 failed | 737 passed
(741)` (the remaining 4 are Plan 002's adapter-test issue, untouched by
this plan). All four typecheck commands clean (they already were before
this plan — don't let them regress).

If vitest shows a different failure count than exactly 4 remaining,
STOP — either a fix above missed a line, or fixed a line it shouldn't
have. Don't proceed to commit; report the discrepancy instead.

## Test plan

No new tests are needed — this plan doesn't change behavior, it
corrects test fixtures to match validation that was always intended.
The existing assertions (`expect(result.success).toBe(true)`, `expect
(res.status).toHaveBeenCalledWith(...)`, etc.) are the test plan; making
them pass again on legitimate input **is** the fix being verified.

## Maintenance note

Any *new* test file added later that needs a placeholder UUID should
copy the pattern from `api/tests/claim.schema.test.ts:4` — third group
starts with `4`, fourth group starts with `8`/`9`/`a`/`b` — not from any
of the six files touched here (they were the bug, not the reference).
If a future zod major bump changes UUID validation again (e.g. zod v5
requiring a specific version like v4-only), re-run this same diagnostic
(`npx tsx` one-liner in the Evidence section above) before assuming the
fixtures are the problem again — confirm against the new version's
actual behavior first.

## Escape hatches

- If `npx vitest run` at Step 1 does **not** show failures in the 6
  files listed, the bump may have already been reverted or fixed since
  this plan was written — STOP, don't apply these diffs blindly, report
  back.
- If any `str_replace`/edit at Steps 2–7 doesn't find the exact old
  string (e.g. line numbers have drifted from further commits since
  `e311775`), don't guess at a fuzzy match — re-`grep` the current file
  for the literal value and re-derive the correct location, or stop and
  report if the literal isn't found at all.
