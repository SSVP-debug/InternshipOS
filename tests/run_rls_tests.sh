#!/usr/bin/env bash
# run_rls_tests.sh
# Rebuilds a scratch local database, applies all migrations, and runs the
# Day 1 RLS/ownership test suite. Exits non-zero on any failure.
#
# Requires a local Postgres superuser session (adjust PSQL_RUN if your local
# setup differs from `sudo -u postgres psql`). This never touches your real
# Supabase project — it's a disposable local database.

set -euo pipefail

DB_NAME="${DB_NAME:-internshipos_test}"
PSQL_RUN="${PSQL_RUN:-sudo -u postgres psql}"
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

echo "== ALL TESTS PASSED =="
