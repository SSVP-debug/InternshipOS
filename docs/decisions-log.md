# Decisions Log — Phase 0

Design choices made during implementation that were flagged for explicit
owner sign-off rather than treated as silent/implicit decisions. Per
project convention: audit or design approval first, then implementation,
then validation.

---

## D-001: Unverified GitHub links → `tier_2_document`, not `tier_3_self_attested`

**Status:** Proposed by implementation, **pending your explicit approval**
(not yet checked off).

**Context:** `EvidenceSource` supports `source_type = 'github_repository'`.
The full design has a GitHub OAuth flow that sets `owner_verified = true`,
which is what should earn `tier_1_verified`. That OAuth flow does not
exist in code yet (tracked as a Phase-beyond-0 gap). In the meantime, a
`github_repository` evidence source with `owner_verified = false` (i.e.,
just a pasted link, unconfirmed) is currently surfaced by Truth Center as
`tier_2_document`.

**Reasoning given at implementation time:** an unverified GitHub link is
still a real, checkable external artifact — closer to an uploaded document
(tier 2) than to a bare self-attested claim with nothing behind it
(tier 3).

**Why this needs sign-off, not just acceptance:** it's a trust-labeling
decision with product-integrity implications — a tier is a promise to
whoever reads a claim later (recruiter, matching engine, eventually an
LLM) about how much to trust it. Downgrading to tier 3 instead is equally
defensible and arguably safer until the OAuth flow exists.

**Options:**
1. **Keep as proposed** — unverified GitHub links stay `tier_2_document`.
2. **Downgrade** — unverified GitHub links become `tier_3_self_attested`
   until OAuth verification exists, reserving tier 2 strictly for actual
   uploaded documents.

**Decision:** ☐ Option 1 (approve as built) ☐ Option 2 (change before
GitHub OAuth ships) ☐ Other: ______________

---

## D-002: `work_authorization` handled as a Truth Center special case

**Status:** Proposed by implementation, **pending your explicit approval**
(not yet checked off).

**Context:** Every other `Claim.subject_entity_type` (Education, Skill,
Project, Experience, Achievement, Certification, EvidenceSource-linked
items) follows the same polymorphic pattern: a per-row `id` the claim
points to, so multiple claims can exist per entity type per candidate.
`work_authorization` breaks this pattern — it's a singleton keyed directly
by `candidate_id` (one record per candidate, not a list), mirroring
`personal_info`.

**Reasoning given at implementation time:** rather than reshaping the
already-shipped, already-validated `0016_claim.sql` schema to accommodate
this one exception, Truth Center's read logic special-cases
`work_authorization`: it looks the record up by `candidate_id` directly
and renders it under a static "Work Authorization" display name, instead
of resolving a name via the normal per-row join every other entity type
uses.

**Why this needs sign-off, not just acceptance:** it's a precedent for how
future singleton-shaped entities (if any) get handled — as one-off
special cases in read logic, versus a schema change. A one-off is cheap
now; if more singleton entities are added later, special-casing each one
individually in Truth Center's query logic could become harder to
maintain than a schema-level fix would have been.

**Options:**
1. **Keep as proposed** — special-cased in Truth Center's read logic, no
   schema change.
2. **Revisit later** — acceptable for now, but flag as tech debt to
   reconsider if a second singleton-shaped entity is ever added.

**Decision:** ☐ Option 1 (approve as built) ☐ Option 2 (approve now, flag
as tech debt) ☐ Other: ______________

---

*No further Truth Center or Export/Deletion decisions require sign-off at
this time. New entries should be appended here as they come up, per
project convention — decisions surfaced before implementation, not
discovered mid-build.*
