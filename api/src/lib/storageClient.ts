// storageClient.ts
// Gate 1a — path/naming helpers for the evidence-documents Storage bucket
// (see 0021_evidence_storage_bucket.sql). Deliberately just helpers, not a
// client factory — every Storage call in this API goes through the
// caller's own req.supabase (userScopedClient), same as every table read/
// write, so storage.objects RLS (not application code) enforces ownership.
// This keeps supabaseClient.ts's documented invariant intact: adminClient
// is still used for exactly the two Auth admin calls it always was.

import { randomUUID } from "node:crypto";

export const EVIDENCE_BUCKET = "evidence-documents";

// Strips anything that isn't alphanumeric/dot/dash/underscore, collapses
// repeats, and caps length — the object path is public-ish (visible in
// signed URLs, error messages, DB rows), so an arbitrary client-supplied
// filename should never be trusted verbatim in it.
export function sanitizeFilename(filename: string): string {
  const cleaned = filename
    .trim()
    .replace(/[^a-zA-Z0-9.\-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const safe = cleaned.length > 0 ? cleaned : "file";
  return safe.length > 120 ? safe.slice(0, 120) : safe;
}

// {candidate_id}/{random-uuid}-{sanitized filename} — the random UUID (not
// a future evidence_source.id, which doesn't exist yet at upload time) is
// the uniqueness guarantee. The candidate_id prefix is what
// storage.foldername(name)[1] matches against in the RLS policies.
export function buildUploadPath(candidateId: string, filename: string): string {
  return `${candidateId}/${randomUUID()}-${sanitizeFilename(filename)}`;
}

// Defense in depth, not the actual security boundary (RLS is): a path that
// doesn't even start with the caller's own candidate_id prefix is
// obviously wrong and can be rejected before ever calling Storage.
export function pathBelongsToCandidate(path: string, candidateId: string): boolean {
  return path.startsWith(`${candidateId}/`);
}
