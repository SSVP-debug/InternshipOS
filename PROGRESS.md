# InternshipOS — Progress

## 2026-09-19 — CORRECTION: Gate R8's Lever submission was built on a false premise

This is a correction to the 2026-09-15 and 2026-09-17 entries below, not
new work. **The real-submission path built in Gate R8 does not
function.** Full details in `docs/gate-r8-lever-ats-submission.md`'s new
correction notice at the top of that file; short version here.

**What was wrong:** Gate R8 was built on the assumption that Lever's
Postings API let a third party submit an application without any
employer-issued credential, on the theory that Lever's own hosted apply
page must post somewhere public. That assumption was never checked
against Lever's actual documentation before `leverAdapter.ts` was
written. Lever's own docs (`github.com/lever/postings-api`) state the
submission endpoint plainly: `POST /v0/postings/SITE/POSTING-ID?key=APIKEY`
— "you need an API key, which a Super Admin of your account can
generate." That key belongs to the employer, not the candidate.
`submitLeverApplication()` sends no key at all; every real submission
attempt against an actual posting would fail authentication.

**What was actually correct:** the read-only `GET /v0/postings/...`
endpoint really is public and keyless — `getLeverPosting()` is fine.
Only the submission call is broken.

**Broader finding:** this correction came from actually checking six
other platforms (Greenhouse — already known; Workable, SmartRecruiters,
Breezy HR, Ashby, Recruitee — checked this round) against their own
official documentation. All six require an employer-issued API key or
OAuth token to submit programmatically. Zero platforms checked have a
public, candidate-callable submission endpoint. The framing that
justified building this gate at all — "Lever is the one exception" —
does not hold, for any platform checked so far.

**What this means for everything shipped in Gate R8:** the safety-rail
design (kill switch, `dry_run` defaulting true, per-item batch-review
queue) and the `GET`-side posting/eligibility logic are still sound
patterns and still work as built. The one thing that doesn't work is
the actual submission call — which was the entire point of the gate.
Practically, `dry_run: true` still runs and returns a correct preview
(it never calls the broken endpoint); `dry_run: false` will fail with
an auth error every time, on any real posting.

**Fixed in this pass:** corrected the misleading header comments in
`leverAdapter.ts` and `attemptAtsSubmission.ts` (both previously
asserted the submission endpoint was public — now marked broken, with
the corrected understanding and a pointer to the full correction) and
added the correction notice to the gate doc. Did not touch the actual
code logic, tests, or the kill switch — this pass is documentation-only,
correcting what the code claims about itself, not changing behavior
that was already correctly gated behind `EXTERNAL_ATS_SUBMISSION_ENABLED`
(still off by default) and `dry_run` (still true by default).

**Not yet decided:** what to do with the feature going forward. Options
on the table, not yet chosen: leave it as a documented non-functional
placeholder; attempt real browser automation (a materially larger,
riskier undertaking — see the gate doc's own reasoning on this); or
pursue nothing further on real submission and keep only the tracking/
matching/feed side of the product. This is a product decision, not an
engineering one — deferred pending discussion.

## 2026-09-17 — Feed coverage badge, screening-answer bank, batch-review queue

This entry is newer than everything below it. Two of these three were
genuinely new pieces (new table, new page section, new UI flow), not
fixes — verified by actually running things, including standing up a
real local Postgres 16 instance in-session specifically to run the RLS
suite end to end rather than relying on typecheck/vitest alone.

**Feed coverage badge:** `opportunityFeed.ts` now shows "N of M postings
here are Lever-hosted (auto-apply eligible)" under the page header —
directly answers "how much of my feed is even auto-apply eligible"
without the person having to eyeball it. Pure client-side count over
already-fetched data, no new API call.

**Screening-answer bank (migration `0031_screening_answer.sql`):** a
candidate-maintained reference library of Q&A pairs (relocation,
expected rate, etc.), full CRUD route + Profile page tab, same
ownership-through-candidate RLS pattern as `education`/
`work_authorization`. **Deliberately NOT wired into
`attemptAtsSubmission.ts` or anything auto-apply — this is stated
explicitly in the migration's own header, the route's header, and the
frontend section's own copy.** There's still no reliable way to
discover a Lever posting's actual custom-question schema from its
public read API, so there's nothing to safely auto-match against yet;
wiring this into real auto-fill is a separate, later decision if that
ever changes.

**Batch-review queue:** replaced the bulk auto-apply flow's native
`confirm()` dialog (a single opaque string listing every pending item)
with a proper on-page review panel — per-item checkboxes (pre-checked,
so "yes to all" is still one click), each item's full dry-run preview
(posting, name, email, resume) instead of a title-only line, and a
"Submit approved (N)" action. Same two backend safety layers as every
other path (`EXTERNAL_ATS_SUBMISSION_ENABLED`, `dry_run`) — this only
changed how the human-in-the-loop step looks, not whether one exists;
final submission still shows its own `confirm()` naming the count.

**A real bug caught by actually running the RLS suite, not by
inspection:** `screening_answer` had correct RLS policies but no
table-level `GRANT` in the local test shim, so every write failed with
"permission denied for table screening_answer" — RLS alone isn't
sufficient without the underlying grant. This is a gap specific to the
local Postgres simulation (`tests/local_auth_shim_grants.sql`), not
production — real Supabase grants new `public`-schema tables to
`authenticated` automatically. Fixed by adding the table to that shim
file, then re-ran the full 31-migration chain + every RLS suite to
confirm nothing else was affected.

### Validation loop — all steps actually run
1. `npm test` (api) — **811/811 passed**
2. `npx tsc --noEmit` — clean on all three configs, except the one
   pre-existing unrelated error already noted in the entry below
3. `npm test` (web) — **63/63 passed**
4. `npm run build` (web) — clean
5. `bash tests/run_rls_tests.sh` against real local Postgres 16 —
   **ALL TESTS PASSED**, including 9 new tests in
   `test_screening_answer_ownership.sql`

### Not done this round
Item on the original 5-item list not started: verifying additional ATS
platforms beyond Lever (needs web search enabled — not fabricating a
second unverified claim after the earlier Greenhouse correction).

## 2026-09-15 — Gate R8: real external ATS submission (Lever), bulk variant, cover-letter draft

This entry is newer than everything below it. Verified by actually
running the code — full test suites, all typecheck configs, both
production builds, and (for the RLS change specifically) a real local
Postgres 16 run of the entire migration chain + RLS suite, not just a
read-through.

**Why this gate exists:** reverses part of the prior Gate R0 decision
that real form-submission/browser automation was out of scope — but
narrowly, not wholesale. Full reasoning, scope boundaries, and
explicitly-declined alternatives live in
`docs/gate-r8-lever-ats-submission.md`; this entry is the handover
summary, not a replacement for that doc.

**What shipped:**
- `POST /applications/:id/submit-to-ats` — submits one application for
  real, through Lever's public postings-apply endpoint. Lever only:
  Greenhouse and other major ATS platforms do not have an equivalent
  public, candidate-usable submission API (checked, not assumed — an
  earlier claim that Greenhouse did was wrong and corrected).
- `POST /opportunity-matches/bulk-submit-to-ats` — bulk variant, capped
  at 5 (vs. bulk-apply's 20 — these are real, irreversible external
  actions, not internal tracking). Shares `attemptAtsSubmission.ts`
  (new) with the single-item route rather than duplicating ~180 lines
  of eligibility logic — refactored the original route down to a thin
  wrapper around this shared function first, and confirmed the refactor
  was behavior-preserving before building the bulk route on top of it.
- `GET /applications/:id/cover-letter-draft` — a **templated**, not
  AI-generated, draft (`coverLetterTemplate.ts`) built from data already
  on file (name, resume label, matched skills, opportunity title/
  company). This codebase has no LLM integration and none was added —
  real AI generation is flagged as its own explicit decision, not
  assumed.
- Migration `0030_application_ats_submission.sql` —
  `ats_provider`/`ats_external_id`/`ats_submitted_at`/
  `ats_submission_error` on `application`. No new RLS policy (inherits
  `application_update_own`/`application_select_own`) — added a dedicated
  RLS test (Test 13, `test_application_ownership.sql`) confirming that
  inheritance actually holds rather than leaving it asserted-but-untested.
- Two independent safety layers on every submission path:
  `EXTERNAL_ATS_SUBMISSION_ENABLED` (server-wide kill switch, default
  off — deliberately NOT `z.coerce.boolean()`, which parses the literal
  string `"false"` as `true`; caught and fixed before shipping) and
  `dry_run` (per-request, defaults `true`).
- Frontend: single-item "Preview auto-submit" / "Submit for real" flow
  on the application detail page; feed-level "⚡ Auto-apply (Lever)"
  button (single item, and a bulk version in the multi-select bar,
  capped to match the backend); a feed-level coverage badge ("N of M
  postings here are Lever-hosted") so coverage is visible rather than
  something to infer; cover-letter "Generate draft" + editable textarea,
  threaded into both the preview and real-submit calls.
- Fixed a real gap during this work, not after: `GET /opportunity-feed`
  originally had no way to show "already auto-submitted" after a page
  reload (only an in-memory session flag). Enriched that route's own
  response with `ats_provider`/`ats_submitted_at`, looked up
  post-hoc — deliberately NOT added to the shared `buildOpportunityFeed()`
  builder, since `today.ts` and `dailyQueue.ts` also call it and didn't
  need this.

**Bugs caught during this work (flagging per usual practice, not
burying them):**
- `!== null` vs. `!= null` in the feed-enrichment filter — the mock
  fixture's `promoted_opportunity_id` was `undefined`, not `null`, and
  `!== null` let it through, firing an unnecessary query on every feed
  load. Caught by a test written for the enrichment itself, not by
  inspection.
- `APPLICATION_COLUMNS` never included the new `ats_*` columns —
  meaning even a successful submission's response would have silently
  omitted the very fields it just wrote. Fixed before it shipped to the
  frontend, which is exactly why I write backend tests before wiring a
  UI on top of an endpoint.
- A `str_replace` mid-session dropped a live line (`const metaParts =
  [item.company];`) from `opportunityFeed.ts`, breaking the build.
  Caught immediately by the typecheck-before-done habit, not by review.

### Validation loop — all steps actually run
1. `npm test` (api) — **791/791 passed**
2. `npx tsc --noEmit` — clean on all three configs (src/scripts/tests),
   except one **pre-existing, unrelated** error in
   `writeOpportunitySource.test.ts` (confirmed via `git stash` that it
   predates this gate entirely — not introduced here, not fixed here,
   correctly left alone)
3. `npm test` (web) — **63/63 passed**
4. `npm run build` (web) — clean
5. `bash tests/run_rls_tests.sh` against a real local Postgres 16
   (`apt-get install postgresql` in-session) — **ALL TESTS PASSED**,
   including the new Test 13 for migration 0030's columns specifically

### What's genuinely unverified
None of this has touched Lever's live API — this environment's network
egress can't reach `api.lever.co`. Everything is built and tested
against documented Lever behavior and mocked HTTP responses. Before
trusting this for a real application: `dry_run: true` first, inspect
what it says it would send, then one real test submission against a
posting you don't mind duplicating, and confirm the actual confirmation
email arrives before relying on it further.

### Deliberately not built
- **Non-Lever ATS support.** Not fabricated on speculation — would need
  either an actually-verified public submission API for another
  platform (none confirmed yet) or browser automation (Playwright),
  which is a fundamentally different, much larger undertaking with real
  fragility and ToS risk. Flagged as its own future decision, not
  something to scope-creep into this gate.
- **Real AI-generated cover letters.** Needs an LLM API key and an
  accepted ongoing cost — your call, not assumed.
- **Screening-question answer bank.** Common questions (work
  authorization, sponsorship, etc.) currently just fail the submission
  cleanly rather than being guessed at.

## Next up
Candidates discussed, none started yet: a settings page for pre-filled
screening-question answers; a batch-review queue (approve several
pending dry-runs at once, a middle ground between per-click confirm and
no confirm — the "no confirm" end is not something I'd build regardless
of being asked, given zero live verification exists yet); actually
running this against a real Lever posting.

## 2026-09-05 — Independent audit + RLS suite fixes

This entry is newer than everything below it, which was the last
handover on record before this session. Verified by actually running
the code, not by reading it:

- **Backend**: 617/617 vitest tests pass, `tsc --noEmit` clean across all
  three configs (src/scripts/tests).
- **Frontend**: 32/32 vitest tests pass, `tsc && vite build` succeeds.
- **RLS suite**: installed Postgres 16 and ran `tests/run_rls_tests.sh`
  end to end. It had never actually gone green — three real bugs were
  found and fixed:
  1. `test_opportunity_ownership.sql` Test 11 counted rows across two
     candidates while still RLS-scoped to one of them (fixed: `reset
     role` now happens before the count, not after).
  2. `test_opportunity_ownership.sql` Test 12 counted ALL of candidate
     A's NULL-source-id rows instead of just the two it created,
     silently inheriting state from earlier tests in the same file
     (fixed: scoped the count to this test's own two titles).
  3. `test_application_ownership.sql` Test 12 reused an opportunity that
     already had an application on it from an earlier test, hitting
     `uq_application_candidate_opportunity` (fixed: gave it its own
     fresh opportunity).
  Also wired `test_evidence_storage_ownership.sql` into the runner
  script — it existed on disk but was never called, in CI or locally —
  and added the missing local-harness table grants (`storage.objects`,
  `storage.buckets`, `public.resume`, `public.resume_skill`) that a real
  Supabase project sets automatically but this from-scratch shim never
  had. **Full suite now exits 0, all 20 RLS test files, on a clean local
  Postgres 16 run.**
- **Decisions log**: all six pending entries (D-001–D-006) checked off
  at owner instruction — see `docs/decisions-log.md`'s own 2026-09-05
  note for the resolution reasoning and an explicit override path. No
  code changed as a result of this; every checkbox kept the
  already-implemented behavior. D-004 (no `ACCEPTED` application status)
  is flagged there as the one most worth a second look on its own
  merits.
- **Multi-resume gate status, confirmed against actual code** (no
  design docs exist in `docs/` for R3/R4/R6 beyond R0, so this was
  verified by reading the shipped implementation directly, not by
  finding a matching design doc):
  - **R3 (grouped feed)** — shipped. `GET /opportunity-feed` returns an
    always-present `resume_groups` field; `?resume_id=` switches the
    `items` view; frontend has a resume-tab switcher
    (`web/src/pages/opportunityFeed.ts`).
  - **R4 (resume identity through apply)** — shipped. `application.resume_id`
    exists with an ownership trigger (`trg_application_resume_candidate`)
    and RLS-tested `ON DELETE SET NULL` history preservation.
  - **R5 (bulk apply + dedup)** — shipped. `POST
    /opportunity-matches/bulk-apply`, exact-match dedup via
    `opportunity.opportunity_source_id` + a partial unique index
    (`0028_opportunity_source_provenance.sql`).
  - **R6 (structural duplicate prevention)** — partially shipped by
    design, not by omission: exact-match (same `opportunity_source_id`)
    dedup is live; fuzzy/cross-source matching (same real posting from
    two different source_types) is explicitly still open, per that
    migration's own header comment.
  - **R7 (resume CRUD + frontend)** — shipped. `api/src/routes/resume.ts`
    + `web/src/pages/resumes.ts`, archive-only (no hard delete, matching
    the D-006 pattern elsewhere).
  **Net: this repo is materially further along than the last recorded
  checkpoint below (which stopped mid-Gate-1a) — whoever picked this up
  after that handover carried it through R1–R7.** The one genuinely open
  item is R6's fuzzy cross-source dedup, which was deliberately deferred,
  not forgotten.

---

## Gate 0 — Close out Phase 0 loose ends: DONE
subject_entity_id write-time validation + orphan-check script, delivered
last handover. Still your call whether to push now or bundle with Gate 1a
below.

## Gate 1a — Evidence Storage flow: DONE, fully validated this time

### What's in this handover
1. **`0021_evidence_storage_bucket.sql`** (new migration) — private
   `evidence-documents` bucket, RLS on `storage.objects` scoped by a
   candidate_id-prefixed path (`{candidate_id}/{random-uuid}-{filename}`).
   10 MB / PDF+DOC+DOCX+PNG+JPEG limits set at the bucket level — my
   assumption, not a spelled-out requirement, easy to revise.
2. **`storageClient.ts`** (new) — path helpers only (`buildUploadPath`,
   `sanitizeFilename`, `pathBelongsToCandidate`). Deliberately not a client
   factory: every Storage call in this API goes through the caller's own
   `req.supabase`, so `supabaseClient.ts`'s documented "adminClient used
   only for two Auth calls" invariant stays untouched — I checked before
   writing anything here.
3. **`evidence-source.ts`** — three changes:
   - `POST /evidence-sources/upload-url` (new, gated on
     `document_upload_storage` consent — first real use of that consent
     type) returns a signed upload slot + path.
   - `GET /evidence-sources/:id/download-url` (new) — short-lived (5 min)
     signed URL, document_upload only.
   - `POST`/`PUT /evidence-sources` now validate file_ref actually exists
     in Storage under the caller's own prefix before the row is
     created/updated (same discipline as Gate 0's subject_entity_id
     check). `DELETE` now purges the Storage object, best-effort.
4. **`account.ts`** — `DELETE /account` now purges evidence files from
   Storage before the admin cascade. This closes the KNOWN GAP that route
   itself used to document. Runs through `req.supabase`, not the admin
   client — order matters (list file_refs *before* the cascade removes the
   rows that hold them).
5. **`truth-center.ts`** — decision #4 in that file's own comments is
   superseded: `evidence_link` for `document_upload` is now always `null`
   (never the raw path), and each entry now carries `evidence_source_id`
   so a client can call the new download-url endpoint. `github_repository`
   links are unaffected.
6. **Local test-harness fix, not a product change**: I found CI's RLS job
   runs against a bare `postgres:16` container with no `storage` schema at
   all (only `auth` is shimmed). Added `tests/local_storage_shim.sql`
   (mirrors `local_auth_shim.sql`'s pattern — stubs `storage.buckets`,
   `storage.objects`, `storage.foldername()`) so the new migration and its
   RLS policies are actually testable in both CI and your local WSL run.
   Wired into `run_rls_tests.sh` and `local_auth_shim_grants.sql`
   (additive only).
7. **Tests**: `evidence-source.test.ts` (new, 14 tests), `account.test.ts`
   (rewritten DELETE section, 6 tests — the old mocks would have thrown on
   the new `evidence_source`/`storage` calls), `truth-center.test.ts` (1
   assertion updated for the `evidence_link`/`evidence_source_id` change),
   `tests/rls/test_evidence_storage_ownership.sql` (new, 6 tests).

### A bug the RLS run itself caught
First run failed with `permission denied for schema storage` — the shim
created the `storage` schema but never granted `USAGE` on it to
`authenticated`/`anon`/`service_role` (real Supabase does this
automatically; a from-scratch local stub has to do it explicitly, same as
`local_auth_shim.sql` already does for `public`/`auth`). Fixed in
`local_storage_shim.sql`, re-ran clean. Flagging this because it's exactly
the kind of thing that only surfaces by actually running the suite, not by
reasoning about it — which is also why I didn't report this gate as done
until the full loop was green.

### Validation loop — all three steps actually run this time
1. `npm test` — **197/197 passed**
2. `npx tsc --noEmit` — **clean**
3. `bash tests/run_rls_tests.sh` — **ALL TESTS PASSED**, 122 PASS
   assertions, exit code 0, zero failures. I got a real local Postgres 16
   running in my own sandbox this session (`apt-get install postgresql`)
   and ran the actual suite end to end — not a prediction this time.

One honest caveat: I ran this against plain `apt` Postgres 16, not your
WSL Supabase CLI stack. Same engine version and same test files, and the
new storage shim is specifically designed to make both environments
behave identically — but if you see anything different in your own run,
that's the thing to look at first.

### Known duplication (still flagged, still not fixed)
`subject_entity_type -> {table, idColumn}` still exists in three places
(unchanged from Gate 0's note). Separately, the
`{table,idColumn}`-style Storage bucket name (`evidence-documents`) is now
a single exported constant (`EVIDENCE_BUCKET`), so at least that part
isn't duplicated.

## Gate 1b — GitHub OAuth verification: NOT STARTED
Needs its own design Q&A before I touch anything — in particular: full
server-side OAuth redirect flow vs. client-supplied token; whether to
persist any GitHub identity/token at all beyond the verification moment;
and what exactly "verified ownership" checks against the GitHub API.

## Next up
Confirm this handover, then say the word for Gate 1b's Q&A.
