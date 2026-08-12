# InternshipOS — Phase 0 / Day 1

This is the first implementation slice of the Candidate Truth Layer, per
`docs/candidate-truth-layer-phase0.md` (the approved architecture). Day 1
scope only: Supabase/Postgres setup, auth, `candidate`, `personal_info`,
`consent_record`, the PII/RLS access boundary, a minimal signup/profile
flow, and tests for ownership + unauthorized access.

## Repository layout

```
supabase/
  migrations/          -- numbered, ordered SQL migrations (source of truth
                          for schema + RLS policies; safe to run against a
                          real Supabase project)
  config.toml
api/
  src/                 -- Express + supabase-js API (signup, profile, consent)
  tests/               -- vitest unit tests (schema validation, auth middleware)
tests/
  local_auth_shim.sql        -- LOCAL TEST ONLY: replicates Supabase's
                                 auth schema/roles on a plain local Postgres
  local_auth_shim_grants.sql -- LOCAL TEST ONLY: table grants, applied after migrations
  rls/test_ownership_and_access.sql -- the Day 1 RLS/ownership test suite
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

## Day 1 scope boundary

This implements Day 1 of `docs/candidate-truth-layer-phase0.md` only.
`Education`, `Skill`, `Project`, `GitHubRepository`, `Experience`,
`Achievement`, `Certification`, `EvidenceSource`, `Claim`, the Truth Center,
and everything from Day 2 onward are **not** implemented here.
