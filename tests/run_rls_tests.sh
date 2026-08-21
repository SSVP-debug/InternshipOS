#!/usr/bin/env bash
# run_rls_tests.sh
# Rebuilds a scratch local database, applies all migrations, and runs the
# Day 1 RLS/ownership test suite. Exits non-zero on any failure.
#
# Connects to the local Supabase CLI's Docker Postgres container over TCP
# (127.0.0.1:54322, standard `supabase start` port from supabase/config.toml).
# Override PSQL_RUN / PGPASSWORD via env vars if your local setup differs
# (e.g. `supabase status` will show your actual DB URL and password if you
# changed them from the CLI defaults). This never touches your real
# Supabase project — it's a disposable local database.

set -euo pipefail

DB_NAME="${DB_NAME:-internshipos_test}"
PSQL_RUN="${PSQL_RUN:-psql -h 127.0.0.1 -p 54322 -U postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== Rebuilding $DB_NAME =="
$PSQL_RUN -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${DB_NAME};"
$PSQL_RUN -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${DB_NAME};"

echo "== Applying local auth shim (pre-migration half) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/local_auth_shim.sql"

echo "== Applying migrations =="
for f in "$ROOT_DIR"/supabase/migrations/*.sql; do
  echo "  -> $f"
  $PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$f"
done

echo "== Applying local auth shim (post-migration grants) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/local_auth_shim_grants.sql"

echo "== Running RLS/ownership test suite (Day 1: candidate, personal_info, consent_record) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_ownership_and_access.sql"

echo "== Running RLS/ownership test suite (Day 2: education) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_education_ownership.sql"

echo "== Running RLS/ownership test suite (Day 2: work_authorization) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_work_authorization_ownership.sql"

echo "== Running RLS/ownership test suite (Day 2: skill) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_skill_ownership.sql"

echo "== Running RLS/ownership test suite (Day 2: project) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_project_ownership.sql"

echo "== Running RLS/ownership test suite (Day 2: experience) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_experience_ownership.sql"

echo "== Running RLS/ownership test suite (Day 2: achievement) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_achievement_ownership.sql"

echo "== Running RLS/ownership test suite (Day 2: certification) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_certification_ownership.sql"

echo "== Running RLS/ownership test suite (Consent Gate: personal_info) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_consent_gate.sql"

echo "== Running RLS/ownership test suite (Day 3: evidence_source) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_evidence_source_ownership.sql"

echo "== Running RLS/ownership test suite (Day 4: claim) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_claim_ownership.sql"

echo "== Running RLS/ownership test suite (Day 5: account deletion cascade) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_account_deletion_cascade.sql"

echo "== Running RLS/ownership test suite (Phase 1: opportunity) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_opportunity_ownership.sql"

echo "== Running RLS/ownership test suite (Phase 1: application) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_application_ownership.sql"

echo "== Running RLS/ownership test suite (Phase 1: application_status_event) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_application_status_event_ownership.sql"

echo "== Running RLS/ownership test suite (Phase 1: application_note) =="
$PSQL_RUN -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$ROOT_DIR/tests/rls/test_application_note_ownership.sql"

echo "== ALL TESTS PASSED =="
