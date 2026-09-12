# Plan 002 — Fix stale hardcoded counts in ingestion adapter tests

**Written against commit:** `e311775` (branch: `master`)
**Status:** TODO
**Depends on:** none (independent of Plan 001 — different root cause,
different files; safe to do in either order or in parallel)

## Why this matters

`api/tests/adzunaAdapter.test.ts` and `api/tests/remoteokAdapter.test.ts`
each have two tests asserting a hardcoded raw-count and filtered-count
against a shared fixture file. Both fixture files
(`tests/fixtures/adzunaSample.ts`, `tests/fixtures/remoteokSample.ts`)
have grown over time as later features (A3.1 skill extraction, A3.3
sponsorship extraction) added new sample entries to exercise those
features end-to-end through the adapter — but the two count-assertion
tests were never updated to match. They now assert numbers that don't
match the fixtures they're reading, which means these two tests give
zero real regression protection today: they'd only fail if a totally
unrelated bug also happened to produce the currently-wrong number by
coincidence, or (as now) if nothing at all is wrong with the adapter
logic and they still fail on the wrong number.

Confirmed by running the adapters against their own fixtures directly:

**Adzuna** (`tests/fixtures/adzunaSample.ts` has 9 raw entries):
```
fetched: 9        (test asserts 7 — tests/adzunaAdapter.test.ts:8)
listings.length: 6 (test asserts 4 — tests/adzunaAdapter.test.ts:15)
listings titles: Software Development Intern, Marketing Internship (Remote),
  Backend Development Intern, Operations Internship — Spring 2026,
  Cloud Infrastructure Intern, Legal Affairs Intern
```
Of the 9 raw entries: 2 are correctly filtered as non-internship
("Senior Software Engineer", "International Business Development
Executive" — the latter specifically testing the word-boundary guard
against matching "Internatio-"), and 1 is correctly dropped as
malformed (missing `company.display_name`). `9 - 2 - 1 = 6`.

**RemoteOK** (`tests/fixtures/remoteokSample.ts` has 7 raw entries, not 5):
```
fetched: 7         (test asserts 5 — tests/remoteokAdapter.test.ts:8)
listings.length: 4 (test asserts 2 — tests/remoteokAdapter.test.ts:15)
listings titles: Frontend Engineering Intern, Data Science Internship,
  DevOps Intern, Product Design Intern
```

**This is a test-debt fix, not an adapter-logic fix.** Both adapters
are behaving correctly against their fixtures — read
`api/src/lib/ingestion/adapters/adzunaAdapter.ts` and `remoteokAdapter.ts`
yourself to confirm the filtering logic (internship-keyword match,
malformed-entry guard, legal-notice guard) before touching anything, but
expect to find nothing wrong there. The fix is entirely in the two test
files' assertions and their stale comments — not in `src/`.

## Files in scope

1. `api/tests/adzunaAdapter.test.ts` (lines 6–9, 11–16)
2. `api/tests/remoteokAdapter.test.ts` (lines 6–9, 11–16)

## Files explicitly out of scope

- `api/src/lib/ingestion/adapters/adzunaAdapter.ts` and
  `remoteokAdapter.ts` — no logic change. If verification in Step 1
  turns up an actual adapter bug (not just a stale count), STOP and
  report back instead of fixing it here — that would be a different,
  separately-scoped finding.
- `tests/fixtures/adzunaSample.ts` / `remoteokSample.ts` — don't trim
  these back down to match the old counts. The extra entries are
  deliberate, targeted test cases for A3.1/A3.3 (see the inline comments
  on each added entry) and removing them would silently lose that
  coverage.
- Any other test in either file beyond the two count assertions — the
  other tests (word-boundary filter, canonical shape mapping, skill/
  sponsorship extraction) are already passing and already correct;
  leave them untouched.

## Steps

### Step 1 — Reproduce and independently re-derive the correct numbers

Don't just trust this plan's numbers — re-derive them yourself first,
since a further commit could have touched the fixtures again since this
plan was written:

```
cd api
npx tsx -e '
import { parseAdzunaListings } from "./src/lib/ingestion/adapters/adzunaAdapter.ts";
import { adzunaSampleResponse } from "./tests/fixtures/adzunaSample.ts";
const { fetched, listings } = parseAdzunaListings(adzunaSampleResponse);
console.log("adzuna fetched:", fetched, "listings:", listings.length);
'
npx tsx -e '
import { parseRemoteOkListings } from "./src/lib/ingestion/adapters/remoteokAdapter.ts";
import { remoteOkSampleResponse } from "./tests/fixtures/remoteokSample.ts";
const { fetched, listings } = parseRemoteOkListings(remoteOkSampleResponse);
console.log("remoteok fetched:", fetched, "listings:", listings.length);
'
```
Expected (as of this plan's commit): `adzuna fetched: 9 listings: 6` and
`remoteok fetched: 7 listings: 4`. If you get different numbers, use
*those* numbers in Steps 2–3 instead of the ones below, and note in your
commit message that the fixture had changed since this plan was
written.

### Step 2 — Fix `api/tests/adzunaAdapter.test.ts`

Lines 6–9:
```diff
   it("reports the raw result count as fetched, independent of filtering", () => {
     const { fetched } = parseAdzunaListings(adzunaSampleResponse);
-    expect(fetched).toBe(7); // all 7 raw results returned by the API, before any filtering
+    expect(fetched).toBe(9); // all 9 raw results returned by the API, before any filtering
   });
```
Lines 11–16:
```diff
   it("drops non-internship postings and the malformed entry missing company", () => {
     const { listings } = parseAdzunaListings(adzunaSampleResponse);
-    // Of 7 raw results: 1 malformed (missing company.display_name) and 2
-    // non-internship postings are dropped -> 4 canonical listings remain.
-    expect(listings).toHaveLength(4);
+    // Of 9 raw results: 1 malformed (missing company.display_name) and 2
+    // non-internship postings are dropped -> 6 canonical listings remain.
+    expect(listings).toHaveLength(6);
   });
```
Verify: `npx vitest run tests/adzunaAdapter.test.ts` → all tests in this file passing.

### Step 3 — Fix `api/tests/remoteokAdapter.test.ts`

Lines 6–9:
```diff
   it("reports the raw entry count as fetched, independent of filtering", () => {
     const { fetched } = parseRemoteOkListings(remoteOkSampleResponse);
-    expect(fetched).toBe(5); // all 5 raw entries in the fixture, including the legal notice
+    expect(fetched).toBe(7); // all 7 raw entries in the fixture, including the legal notice
   });
```
Lines 11–16:
```diff
   it("drops the leading legal-notice entry and any malformed entries", () => {
     const { listings } = parseRemoteOkListings(remoteOkSampleResponse);
-    // Of 5 raw entries: 1 legal notice + 1 malformed (missing company) +
-    // 1 non-internship posting are dropped -> 2 canonical listings remain.
-    expect(listings).toHaveLength(2);
+    // Of 7 raw entries: 1 legal notice + 1 malformed (missing company) +
+    // 1 non-internship posting are dropped -> 4 canonical listings remain.
+    expect(listings).toHaveLength(4);
   });
```
Before finalizing this diff, open `tests/fixtures/remoteokSample.ts`
yourself and confirm there are actually 2 additional non-legal-notice,
non-malformed, non-internship-filtered entries beyond the original 2
canonical ones (to justify "1 legal notice + 1 malformed + 1
non-internship" still being the right breakdown at the new count of 7
raw / 4 canonical — the arithmetic is `7 - 1(legal) - 1(malformed) -
1(non-internship) = 4`, so the comment's breakdown is still accurate at
the new numbers, just double-check the fixture actually only added
internship-flavored entries and not another non-internship one, which
would change the breakdown text even though the final count of 4 might
coincidentally still work out).

Verify: `npx vitest run tests/remoteokAdapter.test.ts` → all tests in this file passing.

### Step 4 — Full verification loop

```
cd api
npx vitest run
npx tsc --noEmit -p tsconfig.json
```
Expected: if run after Plan 001 is also complete, **0 failed** across
the full suite. If run independently (Plan 001 not yet applied), you
should see failures drop from `59 failed | 682 passed (741)` to `55
failed | 686 passed (741)` — the 4 fixed here, Plan 001's 55 untouched.
`tsc --noEmit` stays clean (this plan doesn't touch typed code).

## Test plan

Same as Plan 001's reasoning: no new tests needed. The existing two
assertions per file already test the right thing (raw count reported
independent of filtering; filtered count reflects the drop rules) — they
just need updated numbers. Verifying they pass against the corrected
numbers *is* the test plan.

## Maintenance note

This is exactly the kind of drift that recurs whenever a shared fixture
file is extended for a new feature's tests without grepping for other
tests that count entries in that same fixture. Next time an entry is
added to `adzunaSample.ts` or `remoteokSample.ts` for a new feature,
`grep -rn "toBe(9)\|toHaveLength(6)"` (or whatever the numbers are by
then) across `api/tests/adzunaAdapter.test.ts` first, to catch this
before it ships rather than after. There's no shared constant to fix
this permanently (the counts are asserted as literals, not derived from
`fixture.length`) — switching to `expect(fetched).toBe(adzunaSampleResponse.results.length)`
would eliminate the whole class of bug, but that's a design change
beyond this plan's scope; flagging it here as a "worth considering"
rather than doing it, since asserting a hardcoded number also documents
the fixture's known shape for a future reader, which has its own value.

## Escape hatches

- If Step 1's re-derived numbers don't match `9`/`6` (adzuna) or `7`/`4`
  (remoteok), don't force these exact diffs — substitute the numbers
  you actually measured and update the diff text accordingly.
- If the adapter's filtering logic itself looks wrong when you read it
  in Step 1 (e.g. an off-by-one, or a legitimate internship being
  dropped) — STOP, don't paper over it with a matching test number,
  report it back as a separate finding instead.
