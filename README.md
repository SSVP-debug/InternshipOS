# Round: GitHub URL placeholder (2026-09-07)

## What this adds
Ahead of real GitHub OAuth (app registration, callback route, linked
identity, sync logic — separate, larger work needing your GitHub App
client id/secret), the Settings > GitHub access row now has an inline
"paste your GitHub URL" input + Save button instead of just a static
"Coming soon" pill.

## How it's stored — no schema change
Saved as an ordinary `evidence_source` row, `source_type:
"github_repository"`, `title: "GitHub profile"` (fixed, so it's found
again on reload — distinct from any per-project repo links a candidate
adds separately via Profile > Evidence Sources). `owner_verified` stays
false, exactly as 0015_evidence_source.sql's own comment says it must
until real OAuth exists. Zero backend/migration changes — POST/PUT
/evidence-sources already supported this exactly.

Saving the URL also grants `github_oauth_access` consent (best-effort,
non-blocking) — the URL itself is treated as the actual expression of
intent here, rather than requiring a separate Grant click first. The
clarifying note ("GitHub sync isn't built yet...") stays visible
regardless of granted/saved state, so a "Saved" pill is never confused
with a live connection.

## File changed
- `web/src/pages/settings.ts` (only)

## Test status (run in this session)
- Frontend: 32/32 passing, tsc --noEmit clean.
- Backend: untouched, not re-run (no backend files changed; the routes
  this relies on were already covered by the 617/617 baseline).

## Still open
The real OAuth flow itself — same as noted in the previous round.
