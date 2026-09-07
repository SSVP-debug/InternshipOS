# Round: Resume file upload (2026-09-07)

## What changed
Only 2 files, both frontend — no backend/schema changes were needed. The
backend already had everything (evidence_source_id on resume, the
evidence-documents Storage bucket, signed upload/download flow); the
Resumes page just never used it.

- `web/src/lib/api.ts` — added upload helpers (requestUploadUrl,
  uploadFileToSignedUrl, uploadResumeFile, validateResumeFile,
  getEvidenceDownloadUrl).
- `web/src/pages/resumes.ts` — Add/Edit resume forms now have a real file
  input (PDF/Word/PNG/JPEG, 10MB cap), cards show the attached file with a
  Download button, editing supports replace/remove with best-effort
  cleanup of the old evidence_source row, and document_upload_storage
  consent is handled inline (same "grant and retry" pattern as
  profile.ts's data_processing consent).

## How to merge
Drop these two files into the matching paths in your repo, overwriting
the existing ones:
- web/src/lib/api.ts
- web/src/pages/resumes.ts

## Test status (run in this session)
- Backend: 617/617 passing (unchanged — no backend files touched)
- Frontend: 32/32 passing
- `tsc --noEmit` on web/: clean

## Not verified
The actual upload PUT to Supabase's signed URL was not smoke-tested
against a live Supabase project in this session (no credentials
available here). Worth a manual test after merging: add a resume, attach
a PDF, confirm it downloads back correctly, then replace/remove it and
confirm the old Storage object is gone.
