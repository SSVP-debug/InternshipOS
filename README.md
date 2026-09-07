# Round: GitHub consent honesty fix (2026-09-07)

## The bug
Settings' Consent list treated all 4 consent types identically: click
"Grant" -> pill flips to "GRANTED". For data_processing,
llm_processing, and document_upload_storage that's accurate — granting
those actually unlocks something real server-side. For
github_oauth_access it's misleading: there is no GitHub OAuth route,
callback, or any requireConsent("github_oauth_access") check anywhere in
the backend. Clicking "Grant" only writes a consent_record row; nothing
connects, nothing syncs. The UI made it look like a live integration.

## Fix (frontend-only, 1 file)
`web/src/pages/settings.ts`:
- github_oauth_access now shows a non-clickable "Coming soon" pill
  instead of an actionable "Grant" button, plus an explanatory line:
  "GitHub sync isn't built yet — this only pre-authorizes it for later.
  Granting it does not connect a GitHub account or read any repos."
- If a candidate had already granted it before this fix, it still shows
  "Granted" (that's a true statement about the consent_record) — the
  clarifying note is what fixes the misleading part, not hiding the
  state.
- No backend/schema change: github_oauth_access stays a valid consent
  type for whenever GitHub OAuth is actually built.

## Test status (run in this session)
- Frontend: 32/32 passing, tsc --noEmit clean.
- Backend: untouched, not re-run this round (no backend files changed).

## Still open
Building the real GitHub OAuth flow (app registration, callback route,
storing the linked GitHub identity, actual evidence-sync logic) is a
separate, larger gate — it needs a GitHub OAuth App client id/secret from
you before any of that can be built.
