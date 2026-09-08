# Round: PDF export (2026-09-07/08)

## What changed
"Download export" now downloads a readable PDF instead of a raw JSON
file. Every table the export already covered (account, personal_info,
consent_records, education, work_authorization, skills, projects,
experiences, achievements, certifications, evidence_sources, claims,
opportunities, applications, application_status_events,
application_notes) is unchanged in what's queried or how it's scoped
(RLS + explicit .eq(candidate_id) as before) — only the response format
changed.

## New dependency (approved)
`pdfkit` (^0.20.2) added to `api/package.json` dependencies, plus
`@types/pdfkit` (^0.17.6) as a devDependency for typings. Pure JS, no
native binaries, no headless browser — picked specifically to stay
free-tier/Render-friendly. `package-lock.json` is included so `npm ci`
reproduces exactly.

## Files changed
- `api/package.json`, `api/package-lock.json` — new dependency.
- `api/src/lib/pdfExport.ts` (new) — generic renderer: humanizes
  snake_case keys, formats booleans/null sensibly, renders each table as
  a titled section of label/value rows, "None." for empty sections.
- `api/src/routes/account.ts` — GET /export now streams
  `buildExportPdf(...)` via `pdf.pipe(res)` with
  `Content-Type: application/pdf` instead of `res.json(...)`. The 404
  (no candidate) and 400 (sub-table query error) branches are unchanged.
- `api/tests/account.test.ts` — the two success-path tests now assert
  real PDF output (Content-Type/Content-Disposition headers + "%PDF-"
  magic bytes) via a stream-capturing res mock, instead of JSON body
  fields. This runs pdfkit for real, not mocked.
- `web/src/lib/api.ts` — `exportAccount()` rewritten as a raw
  authenticated fetch returning a `Blob`, bypassing the shared
  `request()` helper (which always does `res.text()` → `JSON.parse`,
  which would mangle binary PDF bytes).
- `web/src/pages/settings.ts` — the download handler now saves the Blob
  directly as `internshipos-export.pdf`; copy updated from "as JSON" to
  "as a PDF".

## Note on the original design doc
docs/candidate-truth-layer-phase0.md §6 originally specified "a
structured (JSON) dump" for data portability. This change is a direct,
explicit departure from that — noted in account.ts's own header comment
— trading portability for readability, per direct instruction. If
machine-readable export is ever needed again (e.g. for an actual
data-portability/GDPR-style requirement), it'd need to be re-added
separately; this round does not keep a JSON fallback.

## Test status (run in this session)
- Backend: 617/617 passing (net-same count: 2 tests rewritten, not
  added/removed). `npm run build` (full tsc, not just --noEmit): clean.
- Frontend: 32/32 passing, tsc --noEmit clean.
- Manually rendered a sample PDF locally and rasterized it to PNG to
  eyeball the actual layout (not just structural validity) — clean
  section headings, correct label formatting, correct pagination,
  "None." for empty sections rather than looking broken.

## Known pre-existing gaps noticed during this work (not fixed, out of scope)
- account.ts's DELETE /account handler still has a "KNOWN GAP" comment
  saying no file-upload flow exists yet to purge Storage objects on
  account deletion — that's stale now that the resume-upload round added
  real Storage uploads via evidence_source. Deleting an account today
  will cascade-delete the evidence_source rows but will NOT purge the
  underlying Storage objects, so orphaned files would accumulate in the
  bucket. Worth its own round if you want it addressed.
