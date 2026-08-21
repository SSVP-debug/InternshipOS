# Phase 1 — InternshipOS Product Loop — Progress

Built on top of the Phase 0 Candidate Truth Layer (`docs/phase-b-progress.md`,
`docs/candidate-truth-layer-phase0.md`) without modifying it. Nothing in
`0001`-`0016` (migrations), the claim lifecycle, RLS ownership model, LLM
boundary, or account export/deletion guarantees was changed.

## What was already working (before this phase)

- Full Candidate Truth Layer backend: `candidate`, `personal_info`,
  `consent_record`, `education`, `work_authorization`, `skill`, `project`,
  `experience`, `achievement`, `certification`, `evidence_source`, `claim`.
- 174 vitest tests passing, `tsc --noEmit` clean, 12 RLS/ownership SQL
  suites, CI green.
- No frontend existed at all — the repo was backend/API infrastructure only.

## What was built in this phase

### Backend

- **4 new migrations** (`0017`-`0020`): `opportunity`, `application`,
  `application_status_event`, `application_note`. Every table follows the
  exact existing RLS pattern (`candidate_id` → `auth.uid()` subquery
  policies). `application`'s status lifecycle is enforced by a DB trigger
  mirroring `claim`'s `ClaimStatus` trigger pattern. See each migration's
  header comment for the specific reasoning, and `docs/decisions-log.md`
  D-003 through D-006 for the modeling choices that need your sign-off.
- **RLS test suites** for all 4 new tables (`tests/rls/test_opportunity_ownership.sql`,
  `test_application_ownership.sql`, `test_application_status_event_ownership.sql`,
  `test_application_note_ownership.sql`), written in the exact structural
  style of the existing 12 suites, and wired into `tests/run_rls_tests.sh`.
  `tests/rls/test_account_deletion_cascade.sql` was extended to seed and
  assert all 4 new tables alongside the original 11, so deletion is proven
  to cascade across all 15 tables together, not just the original set.
- **API routes**: `opportunity.ts`, `application.ts`, `application-note.ts`,
  and `today.ts` (the dashboard), wired into `server.ts`. `schemas.ts`
  extended with the corresponding Zod schemas. `account.ts`'s export
  endpoint extended to include the 4 new tables, preserving the "export
  everything" guarantee.
- **`lib/todayView.ts`**: the Today dashboard's prioritization logic
  (what counts as urgent, what counts as a follow-up, deadline windows)
  extracted as a pure function with no supabase/Express dependency,
  following the same "logic separated from I/O" discipline the Phase 0
  code already used — this is what made it practical to unit-test
  thoroughly (25 tests) without mocking a database.
- **71 new backend tests** (245 total, up from 174): schema validation for
  every new Zod schema, 25 tests covering `todayView.ts`'s prioritization
  logic (deadline windows, follow-up due/overdue, terminal-status
  exclusion, saved-opportunity ranking, resilience to missing data), and
  10 route-level tests (mocked `req.supabase`, same pattern as the
  existing `truth-center.test.ts`/`account.test.ts`) covering the
  highest-risk logic: ownership checks on `POST /applications`,
  `check_violation`/`unique_violation` Postgres error-code mapping to the
  right HTTP status, and status-history writes.

### Frontend (did not exist before this phase)

A Vite + vanilla TypeScript SPA at `web/` — no framework, to keep the
build simple. Visual identity: a "field notebook" feel (paper background,
serif headings, a dashed-edge "index card" motif for dashboard action
items) rather than a generic admin-dashboard look, per the task brief's
explicit steer away from that.

- `lib/auth.ts` — the **only** use of `@supabase/supabase-js` in the whole
  app: sign up/in/out, to obtain the caller's own access token. Every
  actual data read/write goes through the Express API in `lib/api.ts`
  using that token — there is exactly one enforcement path (RLS, behind
  the API), not two that could drift apart.
- `lib/api.ts` — a fully-typed wrapper covering every backend endpoint
  used by the frontend, built by reading the actual route source (not
  assumed) — this caught real mismatches, e.g. the export endpoint being
  `GET /export` (not `/account/export`), and Truth Center's `groups`
  being keyed by entity type rather than an array.
- Pages: sign in / sign up, onboarding (consent + minimal personal info),
  **Today** (the dashboard), **Opportunity Inbox** (add/save/dismiss/
  prioritize/start-application), **Application Tracker** (list + status
  filter), **Application detail** (status transitions via the lifecycle's
  legal-next-states, editable next-action/recruiter/deadline fields, notes
  CRUD, status history), **Truth Center** (read-only, grouped by entity
  type, trust tiers), **Profile** (tabbed: Personal Info, Work
  Authorization, and — via one generic field-config-driven CRUD builder,
  `lib/crudSection.ts`, rather than seven near-identical hand-written
  forms — Education, Skills, Projects, Experience, Achievements,
  Certifications, Evidence Sources, each with an inline claim
  create/confirm/dispute/revoke widget), **Settings** (consent ledger,
  full data export as a downloadable JSON file, account deletion with a
  type-to-confirm guard).

## Tests run and results

```
cd api && npm test          # 245 passed (245), 21 test files
cd api && npx tsc --noEmit  # clean
cd web && npm run build     # tsc --noEmit && vite build — clean, 63 modules, ~256KB JS / ~9KB CSS
tests/run_rls_tests.sh      # ALL 16 SUITES PASSED against a real local Postgres 16
```

The RLS suites were executed end-to-end (all 16: the 12 pre-existing Phase
0 suites plus the 4 new Phase 1 suites) against a real local PostgreSQL 16
instance — 145 individual `PASS` assertions, zero failures. This caught
one real bug in a newly-written test: `test_application_status_event_ownership.sql`'s
permanence test assumed an UPDATE against a table with no UPDATE grant
would silently affect 0 rows (RLS-style denial); in fact a missing
table-level GRANT fails with a hard `permission denied` error before RLS
is even evaluated, which needed catching via `exception when
insufficient_privilege` — the same pattern `test_claim_ownership.sql`'s
test 10 already used for `claim`'s "no DELETE policy" case. Fixed and
re-verified; this is exactly the kind of thing that only running the
suite for real (versus writing it by careful imitation) would catch.

The frontend's production build (`web/dist`) was also smoke-tested at
runtime — not just type-checked and bundled — using Node's ESM loader
with `jsdom`-provided browser globals (`window`, `document`,
`MutationObserver`, etc. patched onto `globalThis`, then `import()`-ing
the built JS module directly, since `jsdom` itself doesn't execute
`<script type="module">` tags). Verified: the login page renders its
actual content ("Welcome back") with zero runtime errors; an
unauthenticated visit to `#/today` correctly redirects to `#/login` (the
auth guard fires); an unknown route renders the "Page not found" page;
the signup page renders. This is a real, if narrow, runtime check —
it confirms the bundle boots, the router works, and the auth guard works,
but it does not click through forms, submit data, or exercise any page
that needs a real Supabase session (Today, Opportunities, Applications,
Truth Center, Profile, Settings) end-to-end.

## Remaining known gaps

- **Frontend authenticated pages (Today, Opportunities, Applications,
  Truth Center, Profile, Settings) have no automated test against a real
  Supabase project or real user flow** — the runtime smoke test confirmed
  the bundle boots, routes, and the auth guard works, but nothing clicked
  through an actual signup → onboarding → add opportunity → track
  application flow against real data. That's the next thing worth doing,
  ideally in a real browser (or Playwright/Puppeteer in CI) against a
  disposable Supabase project, not just Node+jsdom.
- **`OFFER` has no `ACCEPTED` distinction** — flagged as decision D-004.
  A student who accepts an offer has no way to record that; the
  application just stays at `OFFER`.
- **No `DELETE /applications/:id` route** despite the DB RLS policy
  existing for it — flagged as decision D-003/D-006. `WITHDRAWN` is
  currently the only "I'm done with this" action.
- **`application_status_event` history-writing is API-layer, not DB-trigger-enforced**
  — flagged as decision D-005. If `application.status` is ever changed
  through a path other than the one route, no history event gets written,
  and the update+insert are two separate requests (not one transaction).
- **Opportunity is candidate-owned, not a shared catalog** — flagged as
  decision D-003. This was a deliberate Phase 1 scope choice per the task
  brief's steer away from ingestion infrastructure, but it does mean two
  students who both add "Google STEP Intern 2027" get two unrelated rows.
- **No automated deadline/follow-up reminders beyond the Today dashboard**
  — there's no push notification, email, or background job; a student has
  to open the app to see what's due. This matches the brief's "start with
  the simplest reliable implementation... do not build a complicated
  notification infrastructure unless it is genuinely required" guidance,
  but is worth naming explicitly as a gap versus a true reminder system.
- **`work_authorization` and `personal_info` singleton PUT/POST semantics**
  in `lib/api.ts` assume the same route accepts both create and update
  bodies interchangeably (matching the existing backend contract) — this
  wasn't independently re-verified against those specific routes' Zod
  schemas during this phase, only against their route file structure.

## What should NOT be built yet

Unchanged from the task brief's §7 list: recruiter marketplace, recruiter
dashboard, college/TPO platform, mobile app, social network, contests,
friend system, complex recommendation engine, embeddings/vector database,
advanced fraud detection, elaborate GitHub synchronization infrastructure,
complicated notification infrastructure, enterprise billing, multi-tenant
organization system. Also not yet built, per the brief's staged approach:
`ResumeVariant`/`ResumeVariantClaim`/`ApplicationAnswer`/`AnswerClaim`/
`OutcomeEvent` (§9) and any AI-generated application content (§5) — these
depend on the application workflow this phase built existing and being
used first.
