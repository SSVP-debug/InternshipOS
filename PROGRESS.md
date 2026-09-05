# InternshipOS — Progress

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
