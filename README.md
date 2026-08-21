# InternshipOS

A student's daily workspace for running an internship search: discover
opportunities, decide what to apply to, track every application's status,
remember deadlines and follow-ups, and keep a trustworthy record of your
own candidate facts underneath it all.

The codebase is organized in two layers:

- **Candidate Truth Layer** (`docs/candidate-truth-layer-phase0.md`) —
  foundational infrastructure: your profile, education, skills, projects,
  experience, achievements, certifications, and evidence, each backed by a
  `Claim` with a lifecycle (`DRAFT → CONFIRMED/DISPUTED → SUPERSEDED/REVOKED`)
  and a Truth Center that shows how trustworthy each claim is. Only
  `CONFIRMED` claims are ever allowed to cross the LLM boundary
  (`api/src/lib/llmBoundary.ts`).
- **InternshipOS product loop** (Phase 1, built on top of the Truth
  Layer) — the actual daily-use product: a Today dashboard, an Opportunity
  Inbox, an Application Tracker with a real status lifecycle, and
  lightweight notes/follow-ups.

## Repository layout

```
supabase/
  migrations/          -- numbered, ordered SQL migrations (source of truth
                          for schema + RLS policies; safe to run against a
                          real Supabase project). 0001-0016: Candidate Truth
                          Layer. 0017-0020: Phase 1 (Opportunity, Application,
                          ApplicationStatusEvent, ApplicationNote).
  config.toml
api/
  src/                 -- Express + supabase-js API
  tests/               -- vitest unit tests (schema validation, route logic,
                          auth middleware, pure aggregation logic)
web/
  src/                 -- Vite + vanilla TypeScript SPA (no framework)
tests/
  local_auth_shim.sql        -- LOCAL TEST ONLY: replicates Supabase's
                                 auth schema/roles on a plain local Postgres
  local_auth_shim_grants.sql -- LOCAL TEST ONLY: table grants, applied after migrations
  rls/*.sql                  -- RLS/ownership test suites, one file per entity
  run_rls_tests.sh           -- rebuilds a scratch DB and runs every suite
docs/
  candidate-truth-layer-phase0.md -- the approved Phase 0 architecture
  decisions-log.md                -- decisions flagged for explicit owner sign-off
  phase-b-progress.md             -- Phase 0 (Days 1-6) progress notes
  phase-1-progress.md             -- Phase 1 (InternshipOS product loop) progress notes
```

## Prerequisites

- A Supabase project (free tier is sufficient for Phase 0).
- The [Supabase CLI](https://supabase.com/docs/guides/cli) for pushing migrations.
- Node.js 20+ for the API.
- A local Postgres install (or Docker) if you want to run the RLS test
  suite locally without touching your real Supabase project.

## 1. Apply migrations to your Supabase project

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push          # applies supabase/migrations/*.sql in order
```

Migrations are plain, ordered SQL files — no CLI-specific syntax — so
`psql "$SUPABASE_DB_URL" -f supabase/migrations/000X_*.sql` in sequence
works identically if you'd rather not use the CLI.

## 2. Run the API locally

```bash
cd api
cp .env.example .env        # fill in your Supabase project's URL + keys
npm install
npm run dev                 # starts on :3000
```

Try it:
```bash
# Sign up
curl -X POST localhost:3000/signup \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.edu","password":"supersecret1"}'

# Then, using the access_token from your Supabase Auth session
# (e.g. via the Supabase JS client's signInWithPassword on the client side):
curl -X POST localhost:3000/profile \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"legal_first_name":"Alice","legal_last_name":"Nguyen","email":"alice@example.edu","location_country":"US"}'

curl localhost:3000/profile -H "authorization: Bearer $ACCESS_TOKEN"

curl -X POST localhost:3000/consent \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"consent_type":"data_processing"}'
```

## 3. Run the frontend locally

```bash
cd web
cp .env.example .env.local   # same Supabase project's URL + anon key, plus the API's base URL
npm install
npm run dev                  # starts on :5173 by default
```

The frontend uses `@supabase/supabase-js` for exactly one thing —
authentication (sign up/in/out) — to obtain the caller's own access token.
Every actual read/write of application data goes through the Express API
above, using that token, so RLS (not the frontend) is what enforces
ownership.

```bash
npm run build                # tsc --noEmit && vite build -> web/dist
```

## 4. Run the tests

**API unit tests** (no network/Supabase dependency — schema validation,
route logic against a mocked query builder, pure aggregation logic, and
auth middleware):
```bash
cd api
npm test
```

**RLS / ownership / unauthorized-access tests** (require a local Postgres;
this rebuilds a disposable local database, applies all migrations, and
proves ownership boundaries hold — it never touches your real Supabase
project):
```bash
# from repo root, with a local Postgres superuser available as `postgres`
tests/run_rls_tests.sh
```

## Scope boundary

**Candidate Truth Layer (Phase 0, Days 1-6):** `candidate`, `personal_info`,
`consent_record`, `education`, `work_authorization`, `skill`, `project`,
`experience`, `achievement`, `certification`, `evidence_source`, `claim`,
account export/deletion, and the Truth Center read model. See
`docs/phase-b-progress.md`.

**InternshipOS product loop (Phase 1):** `opportunity` (candidate-owned,
manual/import-based discovery), `application` (with a
`SAVED → APPLYING → APPLIED → ASSESSMENT/INTERVIEW → OFFER/REJECTED/WITHDRAWN`
lifecycle), `application_status_event` (history), `application_note`
(lightweight notes), the Today dashboard, and a frontend covering the full
loop. See `docs/phase-1-progress.md` for what's built, what's tested, and
known gaps.

**Not built yet, deliberately** (see task brief and `docs/phase-1-progress.md`
for the full list): recruiter-facing features, AI-generated application
content, resume variants, job-board scraping/ingestion, matching/recommendation
engines, and an `ACCEPTED` status distinct from `OFFER` (flagged as
decision D-004 in `docs/decisions-log.md`).
