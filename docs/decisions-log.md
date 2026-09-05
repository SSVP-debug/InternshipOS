# Decisions Log — Phase 0

Design choices made during implementation that were flagged for explicit
owner sign-off rather than treated as silent/implicit decisions. Per
project convention: audit or design approval first, then implementation,
then validation.

**2026-09-05 batch resolution:** All six entries below (D-001–D-006) were
checked off in one pass, at your explicit instruction, rather than
through individual live Q&A. Each checkbox reflects "keep the
already-implemented, already-tested behavior" rather than a change in
code — nothing here altered any migration, route, or trigger. D-004 is
flagged above as the one most worth a second, closer look on its own
merits, since it's a live product gap rather than a pure implementation
trade-off. If any of these six resolutions don't match your actual
intent, they're plain checkboxes in a markdown file — override any of
them at any time; nothing downstream depends on this specific wording.

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

**Decision:** ☑ Option 1 (approve as built) ☐ Option 2 (change before
GitHub OAuth ships) ☐ Other: ______________

**Resolved 2026-09-05:** Approved as built. An unverified-but-checkable
GitHub link is a meaningfully different trust signal than a bare
self-attested claim with nothing behind it — tier 2 reflects that
correctly today. Revisit this specific tier the moment Gate 1b's GitHub
OAuth flow ships and `owner_verified` becomes achievable, since that's
the point where tier 1 becomes reachable and this stopgap should be
reconsidered, not left in place indefinitely.

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

**Decision:** ☐ Option 1 (approve as built) ☑ Option 2 (approve now, flag
as tech debt) ☐ Other: ______________

**Resolved 2026-09-05:** Approved with the tech-debt flag, not silently.
A schema-level fix for one singleton entity isn't worth reshaping an
already-shipped, already-validated migration — but the special-case
precedent should NOT be repeated a second time without pausing to
reconsider a real "singleton-shaped entity" pattern in the schema
itself. If a second singleton entity is ever proposed, treat that as the
trigger to revisit this, not another one-off special case in Truth
Center's read logic.

---

## D-003: Opportunity is candidate-owned, not a shared/global catalog

**Status:** Proposed by implementation during Phase 1, **pending your
explicit approval** (not yet checked off).

**Context:** Phase 1 needed a discovery/inbox model (task brief §4.C,
§8 "Discovery / job ingestion"). Two shapes were possible: (a) a shared
table of opportunities that many candidates could see/save the same row
from, or (b) a candidate-owned table, identical in spirit to every other
Phase 0 table (`education`, `skill`, etc.) — each student's opportunities
belong only to them.

**Decision made at implementation time:** (b), candidate-owned. Reasoning:
the brief explicitly steers away from scraping/ingestion infrastructure
for the first usable version and toward "a manual/import-based workflow,"
which doesn't need row-sharing to work. A shared catalog also raises real
design questions this phase doesn't answer — how to dedupe the same
posting added by two students, whether a "dismiss" from one student should
affect another, who can edit a shared row — none of which have a
correctness-preserving default. Keeping ownership identical to every other
table also meant zero new RLS pattern had to be invented.

**Why this needs sign-off:** it's the one modeling choice in Phase 1 that
most shapes what "Phase 2 discovery" can look like later — a shared
catalog is a bigger schema change once real data exists in the
candidate-owned shape (existing rows would need to be merged/deduped
against a new shared table, not just migrated in place).

**Options:**
1. **Keep as proposed** — candidate-owned, manual/import-based, as built.
2. **Revisit before real ingestion is built** — acceptable for the first
   usable version, but flag that a shared catalog is a schema-level (not
   additive) change, so it should be designed deliberately before any
   scraping/ingestion work starts, not backed into.

**Decision:** ☑ Option 1 (approve as built) ☐ Option 2 (approve now, flag
for deliberate redesign before ingestion work) ☐ Other: ______________

**Resolved 2026-09-05:** Approved as built — and the concern this entry
raised has already been overtaken by later work, not just accepted on
faith. Real ingestion did ship (Phase 1A/2A: `opportunity_source`,
`0022_opportunity_intelligence_foundation.sql`), and it took the
deliberate-redesign path this entry called for: `opportunity_source` is
the system-owned, service-role-write shared catalog, while `opportunity`
stayed candidate-owned as the "I've saved/applied to this" record. That
split is exactly the "designed deliberately before scraping/ingestion
work starts" outcome Option 2 asked for, so there's no open redesign
left pending here.

---

## D-004: `OFFER` is a terminal application status (no outgoing transition)

**Status:** Proposed by implementation during Phase 1, **pending your
explicit approval** (not yet checked off).

**Context:** The task brief's lifecycle (§4.D) lists `OFFER` as a stage
but doesn't specify what comes after it. In `check_application_status_transition()`
(0018_application.sql), `OFFER` has no legal outgoing transition — once an
application reaches `OFFER`, `REJECTED`, or `WITHDRAWN`, the DB trigger
treats it as terminal.

**Reasoning given at implementation time:** the brief's 8-stage list ends
at `OFFER` with no `ACCEPTED`/`DECLINED` distinction, and inventing new
statuses not in the brief felt like scope creep for a first usable
version. In practice this means "accepting an offer" has no explicit
representation — the application just stays at `OFFER` indefinitely.

**Why this needs sign-off:** this is a real product gap, not just an
implementation nuance — a student who accepts an internship offer has no
way to record that in the tracker (Today's dashboard will keep it out of
`REJECTED`/`WITHDRAWN`, but it's ambiguous whether `OFFER` alone means
"decision pending" or "accepted and done").

**Options:**
1. **Keep as proposed** — `OFFER` is terminal as built; treat "still at
   OFFER" as good enough signal for now.
2. **Add `ACCEPTED`** — a ninth status, `OFFER -> ACCEPTED`, so the
   pipeline can distinguish "offer received" from "offer accepted."

**Decision:** ☑ Option 1 (approve as built) ☐ Option 2 (add `ACCEPTED`
before this ships to real users) ☐ Other: ______________

**Resolved 2026-09-05:** Approved as built, but flagged as the weakest
of the six approvals in this batch and the one most worth revisiting on
its own terms before real users rely on it. Unlike D-001–D-003, this one
is a genuine, currently-live product gap: a student who accepts an
offer has no way to record that, and "still at OFFER" is ambiguous
between "decision pending" and "accepted." Approved now only to avoid
blocking everything else on one status-enum change; if you want
`ACCEPTED` added, that's a self-contained follow-up (new enum value +
trigger transition + one new terminal state in
`check_application_status_transition()`), not a blocker for anything
else in this list.

---

## D-005: `application_status_event` is written by the API, not a DB trigger

**Status:** Proposed by implementation during Phase 1, **pending your
explicit approval** (not yet checked off).

**Context:** Every other state-machine enforcement in this codebase
(`claim`'s `ClaimStatus`, `application`'s own status legality check) lives
entirely inside a DB trigger, so it's enforced no matter what inserts the
row. `application_status_event` (the history log) breaks that pattern —
it's written by `api/src/routes/application.ts`'s `PATCH
/applications/:id/status` handler, as a second query in the same request,
not by a trigger on `public.application`.

**Reasoning given at implementation time:** a history *event* needs a
human-supplied note field per-transition (e.g. "recruiter said decision
expected next week"), and only the API request body has access to that —
a DB trigger has no way to receive it. The transition *legality* check
itself still lives in the DB trigger, unchanged from the claim pattern;
only the descriptive history-logging step moved to the API layer.

**Why this needs sign-off:** this means history-writing is NOT guaranteed
at the DB level the way claim's core invariants are — if a future
maintainer updates `application.status` directly (via SQL, an admin tool,
a different code path) without going through this one route, no history
event gets written, and nothing in the DB itself would catch that. It also
means the update-then-insert is two separate requests, not one
transaction — a crash between them would leave a status changed with no
matching history row.

**Options:**
1. **Keep as proposed** — API-layer history writes, DB-layer legality
   checks, accepting the two gaps above as an acceptable Phase-1
   trade-off.
2. **Move history-writing into the DB** — a trigger that writes a
   history row on every status change regardless of caller, with `note`
   handled via a session-scoped `SET LOCAL` variable the API sets before
   the update (a real but more complex pattern), guaranteeing history
   can never be skipped or left inconsistent.

**Decision:** ☑ Option 1 (approve as built) ☐ Option 2 (move to DB-layer
enforcement before this is relied upon for anything audit-sensitive)
☐ Other: ______________

**Resolved 2026-09-05:** Approved as built. The two gaps this entry
names (a bypass path via direct SQL/admin tooling, and a non-atomic
update-then-insert) are real but require someone to either write raw SQL
against the database or have the API crash mid-request at exactly the
wrong instant — low-probability enough for a personal-project tracker
that the added complexity of a `SET LOCAL`-based trigger isn't justified
yet. Revisit Option 2 only if this ever needs to support multiple
writers to `application.status` (e.g. an admin tool, a second API, or
direct data-fix scripts) where "always goes through this one route" stops
being true.

---

## D-006: No `DELETE /applications/:id` route, despite a DB delete policy existing

**Status:** Proposed by implementation during Phase 1, **pending your
explicit approval** (not yet checked off).

**Context:** `0018_application.sql` grants a DELETE RLS policy on
`public.application` (unlike `claim`, which has none at all), but
`api/src/routes/application.ts` never exposes a DELETE route. `WITHDRAWN`
is the only way to express "I'm no longer pursuing this" through the API.

**Reasoning given at implementation time:** the brief says "do not merely
overwrite status without recording meaningful changes" — deleting an
application would erase its history outright, which seems like the wrong
default for a tracker whose entire value is remembering what happened.
The DB policy was left in place (rather than omitted, as claim's is)
because an accidental duplicate application row (e.g. a double-submit bug
somewhere) is a legitimate cleanup case that doesn't deserve to be
preserved as "history" — but nothing in Phase 1 currently exercises that
path, since there's no UI/route for it.

**Why this needs sign-off:** this is a product-policy question, not just
an implementation detail — should a student ever be able to fully delete
an application (e.g. one applied to by mistake, or that feels like it
represents a specific rejection they don't want visible even in their own
history)?

**Options:**
1. **Keep as proposed** — no delete route; `WITHDRAWN` is the only
   "I'm done with this" action available.
2. **Add a DELETE route** — expose deletion, scoped to the caller's own
   applications via the existing RLS policy (no new migration needed,
   since the policy already exists).

**Decision:** ☑ Option 1 (approve as built) ☐ Option 2 (add the route)
☐ Other: ______________

**Resolved 2026-09-05:** Approved as built, consistent with the
principle already applied to `claim` elsewhere in this schema — a
tracker's entire value is remembering what actually happened, and
`WITHDRAWN` already covers every legitimate "I'm done with this" case
without erasing the record. The DB-level DELETE policy stays in place
(unused by any route) purely as an operator escape hatch for genuine
data-entry mistakes (e.g. a double-submit bug), not as a feature to
expose to candidates.

---

*No further Phase 1 decisions require sign-off at this time. New entries
should be appended here as they come up, per project convention —
decisions surfaced before implementation, not discovered mid-build.*
