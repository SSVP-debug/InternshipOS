# InternshipOS — Progress

Last updated: 2026-08-18 (D-001 and D-002 sign-off resolved — see
`docs/decisions-log.md`. Phase 0 remains complete and pushed. Phase B
(Production Infrastructure) is now the active phase: CI pipeline built
and green; hosting/production Supabase/domain decisions pending owner
input — see "Immediate next steps" below.)

## Overall: Phase 0 is 100% built and validated. Phase B (infra) has begun. Full-platform roadmap (Phase 0 + Phase B + Matching + AI + Product) is ~30%.

```
Candidate Facts    [██████████] 100%  (8/8 entities, validated)
Consent Gate       [██████████] 100%  (validated: 129 API tests, 9/9 RLS suites, pushed)
Evidence + Claim   [██████████] 100%  (validated: 11/11 RLS suites, all tests green, pushed)
Export/Deletion    [██████████] 100%  (validated 2026-08-18: cascade suite green, pushed)
Truth Center       [██████████] 100%  (validated 2026-08-18: 11/11 unit tests green, pushed)
Phase B: CI        [██████████] 100%  (167 tests + tsc + 12 RLS suites run on every push, $0 cost)
Phase B: Hosting    [██████████] 100%  (Render deployed, production Supabase created, free subdomain — done by you 2026-08-18)
Phase B: Keepalive  [██████████] 100%  (workflow built 2026-08-18; needs SUPABASE_URL/SUPABASE_ANON_KEY repo secrets added by you)
Matching           [░░░░░░░░░░]   0%  (not started, not scoped)
AI Layer           [░░░░░░░░░░]   0%  (not started; LLM boundary serializer designed, not coded)
Product Layer      [░░░░░░░░░░]   0%  (far future)
```

**Phase 0 — "Candidate Truth Layer" exactly as scoped in the architecture
doc — is done.** Candidate Facts, Consent, Evidence, Claims,
Export/Deletion, and Truth Center are all built, tested, and pushed.

---

## Done and validated (real local test runs)

- [x] Auth, candidate provisioning, RLS foundation
- [x] Education, Work Authorization, Skills, Projects, Experience,
      Achievements, Certifications (8 candidate-fact domains)
- [x] Consent gate (`0014`) — 129 API tests, 9/9 RLS suites, pushed
- [x] EvidenceSource (`0015`) — 10/10 RLS tests, pushed
- [x] Claim (`0016`) — 12/12 RLS tests including the full
      status-transition trigger, pushed
- [x] `GET /export` + `DELETE /account` (`account.ts`) — 7 API tests,
      cascade-verification SQL suite (`test_account_deletion_cascade.sql`),
      confirmed 2026-08-18: all 11 Phase-0 tables cascade correctly on
      deletion, user B's data confirmed untouched, pushed
- [x] `GET /truth-center` (`truth-center.ts`) — the read model from the
      architecture doc §2. 11 API tests confirmed passing 2026-08-18,
      pushed. No dedicated RLS suite by design (read-only, rides on the
      11 already-validated RLS suites underneath it)

**Full validated test run (2026-08-18):** 15 test files, 167/167 tests
passing; `npx tsc --noEmit` clean; all RLS suites green including Day 1
(candidate/personal_info/consent), Day 2 (7 candidate-fact domains), the
consent gate, Day 3 (evidence_source), Day 4 (claim + status transitions),
and Day 5 (account deletion cascade).

## Open items before Phase 0 is fully closed out (non-code)

- [x] **D-001 sign-off** (resolved 2026-08-18): unverified GitHub-link
      evidence stays `tier_2_document`. See `docs/decisions-log.md` for
      full rationale.
- [x] **D-002 sign-off** (resolved 2026-08-18): work_authorization stays
      special-cased in Truth Center's read logic, no schema change. See
      `docs/decisions-log.md` for full rationale.
- [ ] **Retention policy sign-off**: draft windows, consent copy, and
      reactivation policy proposed in `docs/retention-policy.md`. Nothing
      in this file is implemented in code — it's a policy decision that
      must be approved before the retention job (see "Not started" below)
      is built.

## Not started

- [ ] Retention job itself (inactivity → notice → archived → deleted) —
      blocked on the policy sign-off above; needs a new `candidate.status`
      column, a scheduler, and an email-sending integration (none exists
      in the codebase today)
- [ ] LLM data-boundary serializer (the "only `CONFIRMED` claims reach an
      LLM call" enforcement) — designed conceptually, not implemented
- [ ] Grounding check for generated content
- [ ] GitHub OAuth connection flow (referenced by D-001 above)
- [ ] File storage integration for uploaded evidence documents (current
      `file_ref` is a text reference only, not a working upload/storage
      path)
- [ ] Any frontend/UI — no user-facing interface exists anywhere in the
      codebase; every feature above is an API endpoint only
- [ ] CI/CD pipeline, hosting/deployment configuration — no automated
      testing-on-push, no Dockerfile, no production environment exists
- [ ] Job/internship ingestion, matching engine
- [ ] Embeddings, resume generation, AI-assisted applications
- [ ] Recruiter/TPO platform, candidate discovery

---

## What "100%" means here

100% = Phase 0 (Candidate Truth Layer) fully built, validated, and pushed
— Candidate Facts + Consent + Evidence + Claims + Export/Deletion + Truth
Center. **This is now true.** Matching, AI, and the product layer are
explicitly out of scope for "complete this project" in the sense you've
been using it — they're the next project, not the finish line for this
one. If you mean the full platform (matching + AI + product), overall
completion is closer to 25%, not 100%.

## Immediate next steps, in order

1. ~~Sign off on D-001 and D-002~~ — **done 2026-08-18.**
2. **Priority chosen 2026-08-18: continue Phase B (production
   infrastructure)**, since it's already in motion (CI is built and
   green). Retention-policy sign-off and the LLM boundary serializer
   remain explicitly deferred until Phase B is further along.
3. **Phase B — hosting, production Supabase, and domain are done** (you
   completed these directly on 2026-08-18). Keepalive job is now built
   (`.github/workflows/supabase-keepalive.yml`) — **one manual step
   required from you**: add `SUPABASE_URL` and `SUPABASE_ANON_KEY` as
   GitHub repo secrets (Settings → Secrets and variables → Actions).
   I can't do this step — it needs your Supabase project credentials.
4. **One remaining Phase B question**: your GitHub repo path, to confirm
   Render's auto-deploy-from-GitHub is correctly wired. See
   `docs/phase-b-progress.md`.
5. Retention policy (`docs/retention-policy.md`) and the LLM
   data-boundary serializer remain open but are not currently being
   worked — revisit once the repo-path/deploy question above is closed.