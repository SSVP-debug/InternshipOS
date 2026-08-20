# InternshipOS — Candidate Truth Layer (Phase 0)

The Candidate Truth Layer backend for InternshipOS, per
`docs/candidate-truth-layer-phase0.md` (the approved architecture):
Supabase/Postgres setup, auth, the full Phase 0 candidate-fact table set,
the PII/RLS access boundary, the Claim lifecycle and Truth Center read
model, account export/deletion, and tests for ownership + unauthorized
access. See "Current scope" below for the precise boundary.

## Repository layout

```
supabase/
  migrations/          -- numbered, ordered SQL migrations (source of truth
                          for schema + RLS policies; safe to run against a
                          real Supabase project)
  config.toml
api/
  src/                 -- Express + supabase-js API (see src/server.ts for
                          the full route list)
  scripts/             -- operator-run scripts (production smoke test,
                          orphan-claim integrity check) — never part of
                          the request-serving path
  tests/               -- vitest unit/integration tests (schema validation,
                          middleware, app wiring)
tests/
  local_auth_shim.sql        -- LOCAL TEST ONLY: replicates Supabase's
                                 auth schema/roles on a plain local Postgres
  local_auth_shim_grants.sql -- LOCAL TEST ONLY: table grants, applied after migrations
  rls/                        -- the full RLS/ownership test suite, one file
                                 per entity/concern
  run_rls_tests.sh           -- rebuilds a scratch DB and runs the suite

docs/
  candidate-truth-layer-phase0.md -- the approved architecture (copied in for reference)
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

## 3. Run the tests

**API unit tests** (no network/Supabase dependency — schema validation +
auth middleware logic):
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

## Current scope

The Candidate Truth Layer's Phase 0 (Days 1–6, per
`docs/candidate-truth-layer-phase0.md`) is implemented end to end:
signup/auth, `personal_info`, `consent_record`, `Education`, `Work
Authorization`, `Skill`, `Project`, `Experience`, `Achievement`,
`Certification`, `EvidenceSource`, `Claim` (with the full `ClaimStatus`
lifecycle), account export/deletion, and the Truth Center read model. See
`src/server.ts`'s header comment for the exact route-by-route breakdown,
and `docs/candidate-truth-layer-phase0.md` for the underlying
architecture. GitHub OAuth verification, the ATS Adapter System, the
Matching Layer, the AI/Generation Layer, and the Product Layer are not
implemented here.

## Production / operations

See `docs/production-readiness.md` for environment variables, health
checks (`/healthz`, `/readyz`), logging, rate limiting, CORS, the
deployment model, and known gaps.
