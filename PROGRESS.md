# InternshipOS — Progress

Last updated: 2026-08-18 (Export/Deletion + Truth Center validated: 167/167
API tests, `tsc --noEmit` clean, all RLS suites including the account-
deletion cascade suite passing. Pushed to GitHub. **Phase 0 —
"Candidate Truth Layer" as originally scoped — is complete.**)

## Overall: Phase 0 is 100% built and validated. Full-platform roadmap (Phase 0 + Matching + AI + Product) is ~25%.

```
Candidate Facts    [██████████] 100%  (8/8 entities, validated)
Consent Gate       [██████████] 100%  (validated: 129 API tests, 9/9 RLS suites, pushed)
Evidence + Claim   [██████████] 100%  (validated: 11/11 RLS suites, all tests green, pushed)
Export/Deletion    [██████████] 100%  (validated 2026-08-18: cascade suite green, pushed)
Truth Center       [██████████] 100%  (validated 2026-08-18: 11/11 unit tests green, pushed)
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

- [ ] **D-001 sign-off**: unverified GitHub-link trust tier — see
      `docs/decisions-log.md`. Proposed default in place, awaiting your
      approval.
- [ ] **D-002 sign-off**: work_authorization singleton handling in Truth
      Center — see `docs/decisions-log.md`. Proposed default in place,
      awaiting your approval.
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

1. **Sign off on D-001, D-002, and the retention policy** — three short
   checklists in `docs/decisions-log.md` and `docs/retention-policy.md`.
   Nothing else in Phase 0 is blocked on code; these are the only
   remaining open items, and they're decisions, not implementation.
2. **Choose the next phase.** Per the architecture doc's own sequencing,
   matching is next, but that's a genuinely new scoping exercise (job
   ingestion, a matching engine) rather than a continuation of Phase 0.
   Equally reasonable alternatives, in no particular order:
   - Build the LLM data-boundary serializer now, before any AI feature
     work starts, since the architecture doc treats it as a
     safety-critical prerequisite rather than a nice-to-have.
   - Build a minimal frontend so Phase 0 is actually usable by a real
     student, not just API-complete.
   - Stand up production infrastructure (real Supabase project, CI,
     secrets management) so what's already built can go live.
   - Scope the matching engine as its own fresh design pass.

   This is a genuine decision point, not a default — worth a short
   conversation before picking one.