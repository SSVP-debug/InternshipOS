# InternshipOS — Progress

## Overall completion: ~61% of full roadmap

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
