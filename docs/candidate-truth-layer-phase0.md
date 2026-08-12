# Candidate Truth Layer — Phase 0 Architecture (Revision 2)

This revises the previous design against your eight requirements, then ends
with the concrete Phase-0 schema and a 7-day build sequence. Still no
implementation code — this is the last design pass before you write any.

---

## 1. ClaimStatus

The v1 design had `trust_tier` (how good is the evidence) but nothing
tracking the claim's *lifecycle* (is it still true, still endorsed, still
usable). Those are different axes and both are needed — a Tier-1 claim can
still become stale or wrong.

```
ClaimStatus: DRAFT | CONFIRMED | DISPUTED | SUPERSEDED | REVOKED
```

| Status | Meaning | Usable in generated content? | Who sets it |
|---|---|---|---|
| `DRAFT` | Created (e.g. parsed from an upload, or auto-suggested from a GitHub sync) but not yet reviewed by the student | No | System |
| `CONFIRMED` | Student has explicitly reviewed and affirmed this exact wording | Yes | Student action |
| `DISPUTED` | Evidence went stale, checksum mismatch, or a conflicting claim was detected (see conflict handling below) | No — frozen until resolved | System, on evidence drift |
| `SUPERSEDED` | Replaced by a newer claim version (GPA updates each semester, a bullet gets reworded) | No (points to replacement) | Student action or system on edit |
| `REVOKED` | Student explicitly removed/retracted it | No | Student action |

State transitions are one-directional except `DISPUTED → CONFIRMED`
(re-affirm after review) and `DRAFT → CONFIRMED` / `DRAFT → REVOKED`. Nothing
transitions back into `DRAFT`. `SUPERSEDED` and `REVOKED` claims are never
deleted — they're kept for audit and for outcome-learning history (a claim
used in an application that later got an interview shouldn't vanish from
that application's record just because the student later updated their GPA).

This replaces the informal `student_confirmed: boolean` field from the prior
draft — it was a weaker version of exactly this state machine.

**Note the interaction with `trust_tier`:** status and tier are orthogonal.
A claim can be `tier_1_verified` and still `DRAFT` (system auto-created it
from a GitHub sync, student hasn't looked at it yet). The gate for
generation is **both** `status = CONFIRMED` **and** trust-tier rules from §4
of the prior doc — neither alone is sufficient.

---

## 2. Truth Center (user-facing)

This is the product surface that makes the trust-tier/status system worth
having — without it, all of this is invisible backend bookkeeping.

**Purpose:** one screen where the student sees every claim that could be used
in an application, its evidence, its trust tier, and its status — and can
confirm, dispute, edit, or revoke each one directly.

**Data it needs (all already representable in the schema, no additions
required beyond ClaimStatus):**

```
TruthCenterView (read model, not a new stored entity — derived query)
  claim_id
  claim_text
  subject_entity_type / subject_entity_name   (e.g. "Project: CacheFlow")
  trust_tier            -- tier_1_verified | tier_2_document | tier_3_self_attested
  status                -- DRAFT | CONFIRMED | DISPUTED | SUPERSEDED | REVOKED
  evidence_summary      -- "Verified via GitHub (214 commits)" /
                            "From uploaded resume, page 1" /
                            "Self-reported, no supporting evidence"
  evidence_link         -- deep link to the source (repo URL, uploaded file, etc.)
  last_reviewed_at
  used_in_applications_count   -- how many submitted applications relied on this claim
```

**UI behavior rules:**
- Claims are grouped by entity (Project, Experience, Education...) so the
  student reviews in context, not as a flat list of disconnected sentences.
- `DRAFT` claims are surfaced first / badged — this is the review queue.
- `DISPUTED` claims are visually distinct (e.g. warning state) and block
  the applications that depend on them from re-submitting with that claim
  until resolved.
- Trust tier is shown with plain language, not the enum — "Verified,"
  "Documented," "Self-reported" — plus a one-line explanation of what each
  means, since most students won't intuitively know why the distinction
  matters until it's explained once.
- Every claim shows "`used in N applications`" — this is what makes
  `SUPERSEDED`/`REVOKED` legible: the student can see the blast radius before
  editing something load-bearing.

**Deliberately not in Phase 0 Truth Center:** bulk edit, claim versioning
diff view, claim-level analytics ("this claim correlates with interviews") —
all real, all deferred (§8).

---

## 3. Minimum viable Phase-0 schema vs. deferred

Cutting the prior design down to what Phase 0 actually needs to ship
Discovery + Candidate Truth Layer + a reviewable profile, with nothing that
only pays off once matching/submission exist.

**Phase 0 — build now:**

| Entity | Included fields | Cut from prior draft |
|---|---|---|
| `Candidate` | as designed | — |
| `PersonalInfo` | as designed | — |
| `Education` | as designed | — |
| `WorkAuthorization` | as designed, **current-state only** | `WorkAuthorizationHistory` (already deferred) |
| `Skill` | as designed | `self_rating` enum kept but not enforced/used yet |
| `Project` | as designed | — |
| `GitHubRepository` | as designed | `commit_count_by_candidate` sync can be a manual "refresh" button, not a scheduled job |
| `Experience` | as designed | — |
| `Achievement` | as designed | — |
| `Certification` | as designed | — |
| `EvidenceSource` | as designed | — |
| `Claim` | as designed **+ ClaimStatus** | — |

**Explicitly deferred past Phase 0** (needed for later phases, schema
already accommodates them additively — do not build the tables yet):

- `ResumeVariant`, `ResumeVariantClaim`, `ApplicationAnswer`, `AnswerClaim`
  — Phase 1/2, once matching exists to select claims against.
- `Application`, `OutcomeEvent` — Phase 2, once submission exists.
- `Job` / discovery normalization — separate track, already scoped in the
  architecture doc; not part of Candidate Truth Layer Phase 0 at all.
- Claim embeddings / vector search table — Phase 1, additive.
- Any encryption/KMS beyond platform defaults, transcript OCR, email
  parsing, school-verification API, fraud detection — all previously
  deferred, still deferred.

**Why this split is safe:** every deferred table is either (a) purely
additive — a new table with FKs into today's `Claim`/`Candidate`, no
migration of existing tables — or (b) genuinely out of scope for the
Candidate Truth Layer boundary (Job/Discovery). Nothing in Phase 0 needs to
be reshaped when Phase 1/2 land.

---

## 4. Privacy architecture

PRODUCT.md and the prior design were silent on this — it needs to be decided
before Phase 0, since FERPA-adjacent educational data (GPA, transcripts) and
government-adjacent data (work authorization status) are both in scope from
day one.

**Consent**
```
ConsentRecord
  id             uuid, pk
  candidate_id   uuid, fk
  consent_type   enum(data_processing, github_oauth_access,
                       llm_processing, document_upload_storage)
  granted_at     timestamptz
  revoked_at     timestamptz nullable
  version        text   -- which version of the policy text was shown
```
Granular by type, not one blanket checkbox — `llm_processing` consent is
separable from `data_processing` consent, because a student may reasonably
want their profile stored without ever having it sent to a third-party model
(matters more once resume/answer generation lands, but the consent record
needs to exist from Phase 0 so it's not retrofitted onto existing users).

**Retention**
- Default retention: candidate data is retained while `profile_status` is
  not `archived`, plus a defined grace period after last activity (e.g. 12
  months of inactivity → automated notice → archive) — exact windows are a
  policy decision to make explicitly, not implicitly via "we never delete
  anything."
- `SUPERSEDED`/`REVOKED` claims and evidence: retained for audit as long as
  the candidate account exists, purged on account deletion — no indefinite
  retention past account life.
- Uploaded documents (`EvidenceSource.file_ref`): same lifecycle as the
  claims that cite them; orphaned files (evidence deleted, no claims
  reference it) are garbage-collected on a schedule.

**Deletion**
- Candidate-initiated full deletion is a hard requirement, not a nice-to-
  have, given the data sensitivity. Deletion cascades: `PersonalInfo`,
  `Education`, all claim-bearing entities, `EvidenceSource` (including
  stored files), `Claim` rows themselves.
- Deletion is **destructive**, not a soft `archived` flag — soft-delete is
  for inactivity, hard-delete is for an explicit deletion request. Keep
  these two flows distinct in the data model (`profile_status = archived`
  vs. a real `DELETE` cascade) so they're never confused in code.
- Any downstream data already sent to an LLM provider is bound by that
  provider's own retention terms — this is why §5 (LLM data boundary) matters
  so much: minimize what leaves the system so deletion obligations are
  actually satisfiable.

**Export**
- Candidate-initiated export: a structured (JSON) dump of everything in
  §3's Phase-0 table set, scoped to that candidate_id. This is cheap to build
  (it's close to the example JSON from the prior doc) and should ship in
  Phase 0, not deferred — "data ownership" as a promise is worthless if
  export doesn't exist from day one.

**Data ownership**
- The student owns their data. Practically: export exists, deletion is
  real and complete, and no data is used in aggregate/model-training
  contexts without a separate, explicit, opt-in consent type (not bundled
  into the base `data_processing` consent needed to use the product).

---

## 5. What's allowed to leave the system to an LLM

This is the concrete boundary the "never invent" enforcement from the prior
doc depends on — it needs to be a technical allowlist, not a convention.

**Allowed to be sent to an LLM (Phase 0 has no generation yet, but this is
the contract for Phase 1+):**
- `Claim.claim_text` where `status = CONFIRMED` (never `DRAFT`/`DISPUTED`)
- The `Job` posting text being matched/answered against
- Structural metadata needed for formatting (entity type, dates, skill
  names) — i.e. the *shape* around a claim, not new PII

**Never sent to an LLM:**
- `PersonalInfo` (name, email, phone, location) — application forms need
  these, but they're filled from structured data directly into form fields,
  never passed through a generative call. There is no legitimate case where
  an LLM needs to "phrase" a phone number.
- `WorkAuthorization` raw fields — matching logic (eligible / not eligible)
  is computed deterministically in code (§ hard filters, from the earlier
  architecture doc), never handed to an LLM to reason about. This avoids a
  whole class of failure where a model "helpfully" reinterprets sponsorship
  status.
- Raw uploaded files (transcripts, resumes-as-PDF) — only extracted,
  student-confirmed `Claim` text is eligible, never the raw document.
- Any `Claim` with `status != CONFIRMED`.
- Any evidence file content directly (`EvidenceSource.file_ref` contents) —
  evidence backs a claim, it is not itself sent anywhere.
- Auth/account data (`auth_user_id`, tokens, session data) — obviously, but
  worth stating as a boundary line since it's adjacent to candidate data in
  the same system.

**Mechanism:** this is enforced by a single narrow serialization function —
"claims-for-LLM" — that is the *only* code path allowed to construct an LLM
request payload from candidate data. It queries `Claim` filtered on
`status = CONFIRMED`, selects only `claim_text` + minimal shape metadata, and
nothing else in the codebase is permitted to build an LLM payload by
querying `PersonalInfo`/`WorkAuthorization`/raw files directly. This is a
code-review-enforced boundary in Phase 0 (small team, no generation yet);
worth automating with a lint/test rule once generation ships in Phase 1.

---

## 6. Security boundaries between data domains

Five domains, each with different sensitivity and different access rules:

| Domain | Contains | Access pattern | Notes |
|---|---|---|---|
| **PII** | `PersonalInfo`, auth identifiers | Read by: candidate themself, form-fill at submission time. Never read by: matching/generation logic. | Tightest domain. Consider a separate DB schema/table-level permission boundary, not just app-layer discipline, even in Phase 0. |
| **Candidate facts** | `Education`, `WorkAuthorization`, `Skill`, `Project`, `Experience`, `Achievement`, `Certification` (structural fields, not claim text) | Read by: candidate, matching engine (deterministic filters), Truth Center | Structural/filterable data — dates, enums, categories — used for hard-filter matching, not for generation. |
| **Evidence** | `EvidenceSource` (files, external refs) | Read by: candidate, verification jobs (GitHub sync), Truth Center display | Never read by: LLM calls directly (§5). Files stored with access control scoped to `candidate_id`. |
| **Claims** | `Claim` + `ClaimStatus` | Read by: candidate (Truth Center), matching engine, the narrow "claims-for-LLM" serializer (§5, CONFIRMED only) | The one domain that legitimately crosses into LLM-bound payloads, and only in its filtered form. |
| **Generated/application content** | (deferred to Phase 1+) `ResumeVariant`, `ApplicationAnswer`, `Application` | Read by: candidate (review/approve), submission layer | Downstream of Claims; carries its own provenance links back to the claims used, per the prior doc's design. |

**Why this matters even for a zero-cost MVP:** you don't need a
microservice-per-domain to get the benefit — table-level Postgres
permissions/row-level security policies (free, built into Postgres/Supabase)
are enough to make "PII is never queryable from the code path that talks to
an LLM" a database-enforced fact rather than a hope. That's a cheap,
high-leverage security control to put in place in Phase 0, before any
generation code exists, precisely because it's much cheaper to establish
before there's a codebase depending on looser access than to retrofit later.

---

## 7. Confirming extensibility (matching / explainability / resume selection / answers / outcome learning)

No schema changes from the prior doc's §6 reasoning — restated briefly with
the two additions from this revision folded in:

- **Matching** filters/ranks over `Claim` rows where `status = CONFIRMED`
  (new filter condition, no new tables) plus deterministic fields from the
  Candidate-facts domain (work auth, grad date) — unchanged.
- **Explainability** is now *stronger*, not just preserved: the Truth Center
  data model (§2) already is the explainability surface for the candidate's
  own profile; matching explanations later just need to link into the same
  claim rows and their evidence, reusing this exact read pattern.
- **Resume selection / application answers** — unchanged from prior doc;
  now additionally constrained to only select from `CONFIRMED` claims, which
  is a stronger, not weaker, guarantee than before.
- **Outcome learning** — unchanged; `OutcomeEvent` still attaches to
  `Application`, which still carries claim provenance via
  `ResumeVariantClaim`/`AnswerClaim`.

No redesign required. The additions in this revision (`ClaimStatus`,
consent/retention tables, domain-scoped access) are additive to the existing
model, which is exactly the property §6 of the prior doc was designed to
guarantee.

---

## 8. Unnecessary complexity to cut for a zero-cost MVP

Being honest about what in the prior design is over-engineered for Phase 0:

- **`checksum` on `EvidenceSource` for tamper/drift detection** — real
  concern eventually, but for Phase 0 (no generation, no submission yet,
  small user base) this is speculative hardening. Cut it; add when evidence
  actually starts getting reused heavily downstream (Phase 1+).
- **Scheduled GitHub sync jobs** — a manual "refresh" button the student
  clicks is free and sufficient at Phase 0 scale; a cron-based sync pipeline
  is infrastructure you don't need yet. (Already reflected in §3.)
- **`used_in_applications_count` as a maintained counter** — Phase 0 has no
  `Application` table yet, so this is naturally zero for everyone; don't
  build the counter-maintenance logic now, just design the Truth Center query
  to compute it as 0/blank until Phase 2 exists, then wire it up.
- **Fine-grained per-field consent versioning UI** — the `ConsentRecord`
  table is worth having now (cheap, and retrofitting consent history is
  genuinely painful), but a polished "review what you've consented to" UI
  can wait; a simple consent gate at signup/upload time is enough for Phase 0.
- **Row-level security policies for every table** — worth doing for the
  PII/LLM boundary specifically (§6) because that's the highest-value,
  highest-risk boundary; don't over-invest in RLS policies for every table
  on day one (e.g. `Achievement`, `Certification` don't need the same
  rigor as `PersonalInfo`).
- **Skill taxonomy normalization service** — fuzzy-matching "React" vs
  "React.js" is real but can start as a static lookup table + simple
  string-normalize function; don't build a taxonomy management system in
  Phase 0.

---

## 9. Final Phase-0 architecture (summary)

```
┌───────────────────────────────────────────────────────────┐
│ PII domain            (PersonalInfo, auth)                  │
│  — table-level access restriction; never queried by         │
│    anything LLM-bound                                        │
├───────────────────────────────────────────────────────────┤
│ Candidate-facts domain (Education, WorkAuth, Skill,          │
│                         Project, Experience, Achievement,    │
│                         Certification)                        │
│  — structural fields, drive deterministic filters             │
├───────────────────────────────────────────────────────────┤
│ Evidence domain        (EvidenceSource)                      │
│  — files + external refs, access scoped per candidate         │
├───────────────────────────────────────────────────────────┤
│ Claims domain          (Claim + ClaimStatus)                  │
│  — atomic, evidence-linked, status-gated                      │
│  — only domain with a narrow, filtered path to an LLM         │
│    (CONFIRMED claims only, via one serializer function)       │
├───────────────────────────────────────────────────────────┤
│ Truth Center            (read model over the above)          │
│  — student-facing review/confirm/dispute/revoke UI            │
├───────────────────────────────────────────────────────────┤
│ Privacy layer           (ConsentRecord, retention job,        │
│                          export endpoint, deletion cascade)   │
│  — cross-cutting, applies to every domain above                │
└───────────────────────────────────────────────────────────┘

Deferred (schema-compatible, not built yet):
  ResumeVariant / ApplicationAnswer / Application / OutcomeEvent
  Job / Discovery normalization
  Claim embeddings
```

---

## 10. Implementation sequence — first 7 days

Sequenced so every day ends with something reviewable/testable, and privacy/
security boundaries are established *before* any data exists, not retrofitted.

**Day 1 — Foundations & access boundaries**
- Stand up Postgres (Supabase free tier), auth, base `Candidate` +
  `PersonalInfo` tables.
- Establish the PII access boundary immediately: row-level security /
  table permissions restricting `PersonalInfo` to owner-only reads, before
  any other table exists. This is cheapest to set as precedent on day one.
- `ConsentRecord` table + a minimal consent gate at signup (`data_processing`
  consent required to create a profile).

**Day 2 — Candidate-facts domain**
- `Education`, `WorkAuthorization`, `Skill`, `Project`, `Experience`,
  `Achievement`, `Certification` tables with the validation rules from the
  prior doc (§5: temporal checks, GPA scale requirement, etc.).
- Basic CRUD for each, no UI polish yet — just correct, validated writes.

**Day 3 — Evidence domain**
- `EvidenceSource` table, file upload storage (Supabase storage, free tier),
  GitHub OAuth connection flow with `owner_verified` set only via that flow.
- Manual "refresh" action for GitHub stats (no scheduled job, per §8).

**Day 4 — Claims domain**
- `Claim` table with `ClaimStatus`, polymorphic `subject_entity_id` +
  the application-layer integrity check (validate on write, plus a script
  for the orphan-check, run manually for now rather than as a cron job).
- Claim creation flows: manual entry, and auto-`DRAFT` suggestion from a
  confirmed GitHub repo sync (e.g., a claim scaffold per repo, left in
  `DRAFT` for the student to write up and confirm).

**Day 5 — Truth Center v1**
- The read-model query from §2, grouped by entity, with plain-language
  trust-tier labels and status badges.
- Confirm / dispute / revoke actions wired to `ClaimStatus` transitions.
- This is the first day the product is demoable end-to-end: upload evidence
  → get a draft claim → review it in the Truth Center → confirm it.

**Day 6 — Privacy operations**
- Export endpoint: JSON dump scoped to `candidate_id` across all Phase-0
  tables.
- Deletion flow: real cascading delete (not soft-delete) across PII,
  candidate-facts, evidence (including stored files), and claims, gated
  behind an explicit confirmation step.
- Retention job skeleton (even if the actual inactivity window is just
  configured, not yet enforced by a running scheduler).

**Day 7 — Hardening & the LLM boundary contract**
- Write (but don't yet call) the single "claims-for-LLM" serializer
  function from §5, with a test asserting it only ever selects `claim_text`
  from `status = CONFIRMED` rows and nothing from PII/WorkAuthorization/raw
  files — this test is the enforcement mechanism, written before Phase 1
  ever calls an LLM.
- End-to-end review pass: create a test candidate, populate every Phase-0
  entity, verify Truth Center reflects it correctly, verify export produces
  a complete and accurate dump, verify deletion removes everything including
  stored files.
- Write down the exact retention windows and consent copy as a short policy
  doc (not code) — the missing piece flagged in the prior review, now
  actually decided rather than left open.

By end of Day 7 you have a working, privacy-complete Candidate Truth Layer —
no matching, no generation, no submission — but every later phase builds on
top of it without touching what's already there.
