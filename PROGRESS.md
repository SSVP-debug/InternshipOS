# InternshipOS — Progress

Last updated: 2026-08-17 (Truth Center built — this is the last piece of Phase 0 as originally scoped. Not yet validated by you.)

## Overall: ~58% of the full roadmap (Phase 0 candidate-truth-layer is 100% BUILT, pending your validation run; everything after it hasn't started)

```
Candidate Facts    [██████████] 100%  (8/8 entities, validated)
Consent Gate       [██████████] 100%  (validated: 129 API tests, 9/9 RLS suites, pushed)
Evidence + Claim   [██████████] 100%  (validated: 11/11 RLS suites, all tests green, pushed)
Export/Deletion    [█████████░]  90%  (built, cascade suite fix applied, awaiting your re-run)
Truth Center       [█████████░]  90%  (built, NOT yet validated by you)
Matching           [░░░░░░░░░░]   0%  (not started, not planned yet)
AI Layer           [░░░░░░░░░░]   0%  (not started, not planned yet)
Product Layer      [░░░░░░░░░░]   0%  (far future)
```

**Once Export/Deletion and Truth Center are validated, Phase 0 — "Candidate Truth Layer" exactly as scoped in the architecture doc — is done.**

---

## Done and validated by you (real local test runs)
- [x] Auth, candidate provisioning, RLS foundation
- [x] Education, Work Authorization, Skills, Projects, Experience, Achievements, Certifications (8 candidate-fact domains)
- [x] Consent gate (`0014`) — 129 API tests, 9/9 RLS suites, pushed to GitHub
- [x] EvidenceSource (`0015`) — 10/10 RLS tests, pushed
- [x] Claim (`0016`) — 12/12 RLS tests including the full status-transition trigger, pushed

## Built by me, NOT yet run/validated by you
- [ ] `GET /export` + `DELETE /account` (`account.ts`) — 7 API tests, cascade-verification SQL suite (fixed after your last run caught a seed-data bug — every column now checked directly against the actual migrations, should be clean)
- [ ] `GET /truth-center` (`truth-center.ts`) — the read model described in the architecture doc §2: every claim, grouped by the entity it's about, with computed `trust_tier` (never stored — derived from evidence at read time), plain-language trust labels, and evidence links. 11 API tests, no new migration (this route is pure aggregation over Claim + EvidenceSource + the 7 fact tables).

**→ Next step: same validation loop —**
```powershell
cd api && npm test && npx tsc --noEmit
```
```bash
bash tests/run_rls_tests.sh
```
Note: Truth Center has no dedicated RLS suite of its own, by design — it does no writes and every read it makes already goes through the RLS policies validated by the 11 existing suites. Its own correctness (grouping, trust-tier computation, name resolution) is covered by the 11 `truth-center.test.ts` unit tests instead.

**Two decisions made while building this that are worth your explicit sign-off, not just silent choices:**
1. An **unverified** `github_repository` evidence source (linked but not yet confirmed via the GitHub OAuth flow, which doesn't exist yet) is shown as `tier_2_document`, not `tier_3_self_attested`. Reasoning: it's still a real, checkable external link — closer to an uploaded document than to nothing at all. Only `owner_verified = true` reaches `tier_1_verified`.
2. `work_authorization` is the one `Claim.subject_entity_type` that doesn't cleanly fit the polymorphic pattern — it's a singleton keyed by `candidate_id`, not a per-row `id` (mirrors `personal_info`). Truth Center handles this as a special case (looks it up by `candidate_id`, uses a static "Work Authorization" display name) rather than changing the already-shipped `0016_claim.sql` schema.

## Not started
- [ ] LLM data-boundary serializer (the "only `CONFIRMED` claims reach an LLM call" enforcement) — designed conceptually, not implemented in code yet
- [ ] Grounding check for generated content
- [ ] Retention job (inactivity → notice → `archived`) — distinct from hard deletion, still open; needs the exact windows written down as policy first (see below)
- [ ] Job/internship ingestion, matching engine
- [ ] Embeddings, resume generation, AI-assisted applications
- [ ] Recruiter/TPO platform, candidate discovery

---

## What "100%" means here
100% = Phase 0 (Candidate Truth Layer) fully built, validated, and pushed — Candidate Facts + Consent + Evidence + Claims + Export/Deletion + Truth Center. Matching, AI, and the product layer are explicitly out of scope for "complete this project" in the sense you've been using it — they're the next project, not the finish line for this one. If you actually mean the full platform (matching + AI + product), overall completion is closer to 25%, not 58%.

## Immediate next 3 steps, in order
1. **Validate Export/Deletion + Truth Center** — the usual loop. Once both are green and pushed, Phase 0 is complete as originally scoped — genuinely a milestone worth pausing on before starting anything new.
2. **Write the retention-window policy note** the doc calls for (exact inactivity windows, consent copy) — not code, a short decision doc so it's explicit rather than implied. Small, but it's the one piece of Phase 0 the architecture doc flags as a real gap if left unwritten.
3. Decide what's next: the doc's own sequencing puts **matching** after Phase 0, but that's a genuinely new project phase (job ingestion, a matching engine) worth a fresh scoping conversation rather than just continuing to build — this is a natural pause point to check the roadmap still matches what you actually want to build next.




