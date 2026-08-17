# InternshipOS — Progress

Last updated: 2026-08-15 (Export + Deletion built, not yet validated by you)

## Overall: ~48% of the full roadmap (Phase 0 candidate-truth-layer is ~98% built, pending your validation run; everything after it hasn't started)

```
Candidate Facts    [██████████] 100%  (8/8 entities, validated)
Consent Gate       [██████████] 100%  (validated: 129 API tests, 9/9 RLS suites, pushed)
Evidence + Claim   [██████████] 100%  (validated: 11/11 RLS suites, all tests green, pushed)
Export/Deletion    [█████████░]  90%  (built, NOT yet validated by you)
Truth Center       [░░░░░░░░░░]   0%  (not started)
Matching           [░░░░░░░░░░]   0%  (not started, not planned yet)
AI Layer           [░░░░░░░░░░]   0%  (not started, not planned yet)
Product Layer      [░░░░░░░░░░]   0%  (far future)
```

---

## Done and validated by you (real local test runs)
- [x] Auth, candidate provisioning, RLS foundation
- [x] Education, Work Authorization, Skills, Projects, Experience, Achievements, Certifications (8 candidate-fact domains)
- [x] Consent gate (`0014`) — 129 API tests, 9/9 RLS suites, pushed to GitHub
- [x] EvidenceSource (`0015`) — 10/10 RLS tests, pushed
- [x] Claim (`0016`) — 12/12 RLS tests including the full status-transition trigger, pushed

## Built by me, NOT yet run/validated by you
- [ ] `GET /export` — JSON dump of all 11 Phase-0 tables scoped to the caller, via `account.ts`
- [ ] `DELETE /account` — real cascading deletion via the Auth admin API (`supabase.auth.admin.deleteUser`), relying on the `auth.users → candidate → every domain table` FK cascade chain
- [ ] `account.test.ts` — 7 tests (4 export, 3 deletion), `adminClient` mocked so no real Supabase call happens in tests
- [ ] `test_account_deletion_cascade.sql` — 3 tests: seeds one candidate across **all 11 tables**, deletes their `auth.users` row directly, confirms every single row is gone, confirms a second candidate's data is completely untouched

**→ Next step: same validation loop as always —**
```powershell
cd api && npm test && npx tsc --noEmit
```
```bash
bash tests/run_rls_tests.sh
```

**One known, deliberate gap, not a bug:** `DELETE /account` does not purge files from Supabase Storage. The architecture doc says deletion should include "EvidenceSource (including stored files)," but no file-upload endpoint exists yet in this repo — `evidence_source.file_ref` is just a text path today, nothing has ever actually written to Storage through this API. Storage purge needs to be added when the real upload flow is built, not invented ahead of it. Flagged in code comments in `account.ts` too.

## Not started
- [ ] **Truth Center** read-only aggregation endpoint (candidate facts + claims + evidence + computed `trust_tier`, rolled up) — the last piece of Phase 0
- [ ] LLM data-boundary serializer (the "only `CONFIRMED` claims reach an LLM call" enforcement) — designed conceptually, not implemented in code yet
- [ ] Grounding check for generated content
- [ ] Retention job (inactivity → notice → `archived`) — distinct from hard deletion, still open
- [ ] Job/internship ingestion, matching engine
- [ ] Embeddings, resume generation, AI-assisted applications
- [ ] Recruiter/TPO platform, candidate discovery

---

## What "100%" means here
100% = Phase 0 (Candidate Truth Layer) fully built, validated, and pushed — Candidate Facts + Consent + Evidence + Claims + Export/Deletion + Truth Center. Matching, AI, and the product layer are explicitly out of scope for "complete this project" in the sense you've been using it — they're the next project, not the finish line for this one. If you actually mean the full platform (matching + AI + product), overall completion is closer to 20%, not 48%.

## Immediate next 3 steps, in order
1. **Validate Export + Deletion** — the same `npm test` / `tsc` / `run_rls_tests.sh` loop. The cascade suite is the one to watch closest: it's proving a real, destructive operation works correctly across every table before you'd ever want to trust it in production.
2. **Truth Center** — the read-only rollup endpoint. This is the actual finish line for Phase 0 — once it's done, "Candidate Truth Layer" as originally scoped is complete.
3. Write the short **retention-window policy note** the doc calls for (exact inactivity windows, consent copy) — not code, just a decision to write down so it's explicit rather than implied.



