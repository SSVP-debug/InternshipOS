// evidence-source.ts
// GET    /evidence-sources               — list the caller's own evidence sources
// GET    /evidence-sources/:id           — get one of the caller's own evidence sources
// GET    /evidence-sources/:id/download-url — a short-lived signed URL to
//                                          download a document_upload's file
// POST   /evidence-sources/upload-url    — a short-lived signed URL + Storage
//                                          path to upload a new document to,
//                                          gated on document_upload_storage
//                                          consent (Gate 1a)
// POST   /evidence-sources               — create an evidence source for the
//                                          caller. For document_upload, first
//                                          verifies file_ref actually exists
//                                          in Storage under the caller's own
//                                          candidate_id prefix (Gate 1a)
// PUT    /evidence-sources/:id           — update one of the caller's own evidence sources
// DELETE /evidence-sources/:id           — delete one of the caller's own
//                                          evidence sources; for
//                                          document_upload, also purges the
//                                          Storage object (best-effort)
//
// Same pattern as skill.ts: every query runs through req.supabase (the
// caller's own JWT), so Postgres RLS — not this code — is what prevents
// reading/writing another candidate's evidence. A foreign id resolves to
// not-found, never another candidate's data.
//
// owner_verified is never accepted from the request body (mirrors
// skill.ts's treatment of evidence_backed) — it is settable only by the
// GitHub OAuth verification flow, which does not exist yet in this repo
// and is out of scope for this CRUD route.
//
// Storage: single private bucket 'evidence-documents' (RLS + bucket
// defined in 0021_evidence_storage_bucket.sql, which explicitly defers the
// upload/download flow itself to this file). Object path convention,
// fixed by that migration: {candidate_id}/{random-uuid}-{sanitized
// filename} — the random UUID (not evidence_source.id, which doesn't
// exist yet at upload time) is the uniqueness guarantee for the
// "get a Storage handle, then create the row that references it" flow.

import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireConsent } from "../middleware/requireConsent.js";
import { EvidenceSourceRequestSchema, UploadUrlRequestSchema, UuidParamSchema } from "../lib/schemas.js";

const EVIDENCE_SOURCE_COLUMNS =
  "id, source_type, title, file_ref, external_url, owner_verified, created_at, updated_at";

const EVIDENCE_BUCKET = "evidence-documents";
const DOWNLOAD_URL_EXPIRY_SECONDS = 300; // 5 minutes

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

// Keeps only characters safe in a Storage object path segment. Not a
// general-purpose slugify — just enough to make an arbitrary user-chosen
// filename safe to concatenate into {candidate_id}/{uuid}-{this}.
function sanitizeFilename(filename: string): string {
  const sanitized = filename.trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
  return sanitized.length > 0 ? sanitized : "file";
}

// Gate 1a (0021_evidence_storage_bucket.sql): file_ref has no DB-level FK
// into Storage — same "polymorphic/cross-system reference is an
// application-layer check" reasoning as claim.ts's subject_entity_id.
// Two independent checks, cheapest first:
//   1. file_ref must be under the caller's OWN candidate_id prefix — pure
//      string check, no I/O, and rejects a foreign/forged path before ever
//      asking Storage about it.
//   2. the object must actually exist in Storage — confirms this isn't a
//      path the caller merely typed/guessed without ever uploading.
// Both failure modes report the same "file_ref_not_found" — from the
// caller's perspective there's no meaningful difference between "not
// yours" and "doesn't exist", and distinguishing them would leak whether
// a given path belongs to someone else.
async function fileRefExistsUnderOwnPrefix(req: AuthedRequest, candidateId: string, fileRef: string): Promise<boolean> {
  const prefix = `${candidateId}/`;
  if (!fileRef.startsWith(prefix)) return false;

  const relativeName = fileRef.slice(prefix.length);
  const { data, error } = await req.supabase!.storage.from(EVIDENCE_BUCKET).list(candidateId, { search: relativeName });

  if (error || !data) return false;
  return data.some((entry) => entry.name === relativeName);
}

export function evidenceSourceRouter(): Router {
  const router = Router();

  router.get("/evidence-sources", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("evidence_source")
      .select(EVIDENCE_SOURCE_COLUMNS)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "evidence_source_fetch_failed", message: error.message });
    }
    return res.status(200).json({ evidence_sources: data });
  });

  router.get("/evidence-sources/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("evidence_source")
      .select(EVIDENCE_SOURCE_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "evidence_source_fetch_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "evidence_source_not_found" });
    }
    return res.status(200).json({ evidence_source: data });
  });

  router.get("/evidence-sources/:id/download-url", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("evidence_source")
      .select(EVIDENCE_SOURCE_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "evidence_source_fetch_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "evidence_source_not_found" });
    }
    if (data.source_type !== "document_upload" || !data.file_ref) {
      return res.status(400).json({ error: "not_a_document_upload" });
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .createSignedUrl(data.file_ref, DOWNLOAD_URL_EXPIRY_SECONDS);

    if (signError || !signed) {
      return res
        .status(400)
        .json({ error: "download_url_creation_failed", message: signError?.message ?? "unknown storage error" });
    }

    return res.status(200).json({ download_url: signed.signedUrl, expires_in: DOWNLOAD_URL_EXPIRY_SECONDS });
  });

  router.post("/evidence-sources/upload-url", requireConsent("document_upload_storage"), async (req: AuthedRequest, res) => {
    const parsed = UploadUrlRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const path = `${candidateId}/${randomUUID()}-${sanitizeFilename(parsed.data.filename)}`;

    const supabase = req.supabase!;
    const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUploadUrl(path);

    if (error || !data) {
      return res
        .status(400)
        .json({ error: "upload_url_creation_failed", message: error?.message ?? "unknown storage error" });
    }

    return res.status(201).json({ path: data.path, signed_url: data.signedUrl, token: data.token });
  });

  router.post("/evidence-sources", async (req: AuthedRequest, res) => {
    const parsed = EvidenceSourceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    if (parsed.data.source_type === "document_upload") {
      const exists = await fileRefExistsUnderOwnPrefix(req, candidateId, parsed.data.file_ref as string);
      if (!exists) {
        return res.status(400).json({ error: "file_ref_not_found" });
      }
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("evidence_source")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(EVIDENCE_SOURCE_COLUMNS)
      .single();

    if (error) {
      return res.status(400).json({ error: "evidence_source_create_failed", message: error.message });
    }
    return res.status(201).json({ evidence_source: data });
  });

  router.put("/evidence-sources/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = EvidenceSourceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("evidence_source")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .select(EVIDENCE_SOURCE_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "evidence_source_update_failed", message: error.message });
    }
    // RLS makes a cross-candidate update a no-op (0 rows), which surfaces
    // identically to "id doesn't exist" — no information leak either way.
    if (!data) {
      return res.status(404).json({ error: "evidence_source_not_found" });
    }
    return res.status(200).json({ evidence_source: data });
  });

  router.delete("/evidence-sources/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("evidence_source")
      .delete()
      .eq("id", idParsed.data)
      .select(EVIDENCE_SOURCE_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "evidence_source_delete_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "evidence_source_not_found" });
    }

    // Best-effort Storage purge: the row is already gone (the part RLS/
    // the DB guarantees), so a Storage failure here must never turn into
    // an error response for a delete that already succeeded — it would
    // leave the API contract lying about whether the delete worked.
    if (data.source_type === "document_upload" && data.file_ref) {
      await supabase.storage.from(EVIDENCE_BUCKET).remove([data.file_ref]);
    }

    return res.status(204).send();
  });

  return router;
}
