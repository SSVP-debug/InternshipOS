-- 0021_evidence_storage_bucket.sql
-- Gate 1a — Storage backing for EvidenceSource.file_ref (document_upload).
--
-- Closes the gap flagged in 0015_evidence_source.sql / account.ts / truth-
-- center.ts: file_ref has existed as a plain text column since Day 3, but
-- nothing wrote to Storage or purged it. This migration adds the bucket +
-- RLS; the upload/download flow itself lives in evidence-source.ts.
--
-- Design, approved before writing this migration:
--   - One private bucket ('evidence-documents'), not per-candidate buckets.
--   - Object path convention: {candidate_id}/{random-uuid}-{sanitized filename}.
--     The random UUID (not the future evidence_source.id) is the uniqueness
--     guarantee — a client requests an upload slot BEFORE an evidence_source
--     row exists to attach an id to, same chicken-and-egg reasoning as every
--     other "get a handle, then create the row that references it" flow.
--   - RLS on storage.objects mirrors every other table in this schema:
--     ownership resolved by matching the candidate to auth.uid(), except the
--     "ownership" here is the first path segment (candidate_id) rather than
--     a candidate_id column, since storage.objects is Supabase-managed and
--     not one of ours to add a column to.
--   - file_size_limit / allowed_mime_types set at the bucket level (10 MB;
--     PDF, DOC, DOCX, PNG, JPEG) as a reasonable default for resume/
--     transcript/certificate-style evidence documents — flagged as an
--     assumption, not a spelled-out product requirement, easy to revise.
--
-- storage.buckets / storage.objects already exist and already have RLS
-- enabled on a real Supabase project — the `if not exists` / idempotent-
-- insert phrasing here is so this migration is a no-op there beyond the
-- actual bucket row + policies. On the disposable local-Postgres RLS test
-- harness (tests/local_storage_shim.sql, applied before this file runs),
-- those same tables are stubbed from scratch so this migration exercises
-- identically in both places.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'evidence-documents',
  'evidence-documents',
  false,
  10485760, -- 10 MB
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg'
  ]
)
on conflict (id) do nothing;

-- ── RLS ──────────────────────────────────────────────────────────────────
-- storage.foldername(name) returns the path split on '/', all segments
-- before the filename — for our convention ({candidate_id}/{file}), that's
-- a one-element array whose [1] is the candidate_id. Same ownership-
-- through-candidate subquery pattern as every other policy in this repo,
-- just keyed off a path segment instead of a candidate_id column.

drop policy if exists evidence_documents_select_own on storage.objects;
create policy evidence_documents_select_own
  on storage.objects
  for select
  using (
    bucket_id = 'evidence-documents'
    and exists (
      select 1 from public.candidate c
      where c.auth_user_id = auth.uid()
        and c.id::text = (storage.foldername(name))[1]
    )
  );

drop policy if exists evidence_documents_insert_own on storage.objects;
create policy evidence_documents_insert_own
  on storage.objects
  for insert
  with check (
    bucket_id = 'evidence-documents'
    and exists (
      select 1 from public.candidate c
      where c.auth_user_id = auth.uid()
        and c.id::text = (storage.foldername(name))[1]
    )
  );

-- No update policy — evidence documents are immutable once uploaded
-- (re-uploading means a new object + a new evidence_source row, same
-- "claims are never edited in place, only superseded" spirit as 0016's
-- no-DELETE-on-claim rule, applied here to files instead).

drop policy if exists evidence_documents_delete_own on storage.objects;
create policy evidence_documents_delete_own
  on storage.objects
  for delete
  using (
    bucket_id = 'evidence-documents'
    and exists (
      select 1 from public.candidate c
      where c.auth_user_id = auth.uid()
        and c.id::text = (storage.foldername(name))[1]
    )
  );
