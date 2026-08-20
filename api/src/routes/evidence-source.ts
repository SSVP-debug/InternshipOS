// evidence-source.ts
// POST   /evidence-sources/upload-url    — Gate 1a: request a signed Storage
//                                           upload slot before a row exists
// GET    /evidence-sources               — list the caller's own evidence sources
// GET    /evidence-sources/:id           — get one of the caller's own evidence sources
// GET    /evidence-sources/:id/download-url — Gate 1a: short-lived signed
//                                           download URL for a document_upload
// POST   /evidence-sources               — create an evidence source for the caller
// PUT    /evidence-sources/:id           — update one of the caller's own evidence sources
// DELETE /evidence-sources/:id           — delete (row + underlying Storage object)
//
// Same pattern as skill.ts: every query runs through req.supabase (the
// caller's own JWT), so Postgres RLS — not this code — is what prevents
// reading/writing another candidate's evidence. A foreign id resolves to
// not-found, never another candidate's data. Storage calls below go
// through the same req.supabase client (storage.objects RLS from
// 0017_evidence_storage_bucket.sql enforces the equivalent ownership rule
// for files) — no admin/service_role client is used anywhere in this file.
//
// owner_verified is never accepted from the request body (mirrors
// skill.ts's treatment of evidence_backed) — it is settable only by the
// GitHub OAuth verification flow (Gate 1b, not yet built).

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { EvidenceSourceRequestSchema, UploadUrlRequestSchema, UuidParamSchema } from "../lib/schemas.js";
import { requireConsent } from "../middleware/requireConsent.js";
import { EVIDENCE_BUCKET, buildUploadPath, pathBelongsToCandidate } from "../lib/storageClient.js";

const EVIDENCE_SOURCE_COLUMNS =
  "id, source_type, title, file_ref, external_url, owner_verified, created_at, updated_at";

// A signed download URL is short-lived by design (see the Gate 1 decision
// to expose links only via a dedicated on-demand endpoint, never embedded
// in list/Truth Center responses): long enough for a client to act on it
// immediately, short enough that a leaked/logged URL isn't useful for long.
const DOWNLOAD_URL_TTL_SECONDS = 300;

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

// Gate 0-style write-time validation, applied to file_ref the same way
// claim.ts validates subject_entity_id: a file_ref pointing at a path that
// either isn't under the caller's own candidate_id prefix, or doesn't
// actually exist in Storage, is rejected before the row is ever created —
// rather than allowing a dangling/foreign reference that Truth Center or a
// future download-url request would just silently fail against later.
async function fileRefIsValid(req: AuthedRequest, candidateId: string, fileRef: string): Promise<boolean> {
  if (!pathBelongsToCandidate(fileRef, candidateId)) return false;
  const { data, error } = await req.supabase!.storage.from(EVIDENCE_BUCKET).list(candidateId, {
    search: fileRef.slice(candidateId.length + 1),
  });
  return !error && !!data && data.length > 0;
}

export function evidenceSourceRouter(): Router {
  const router = Router();

  // Registered before /evidence-sources/:id so Express doesn't try to
  // match "upload-url" as a :id param — same ordering concern as any
  // static-segment-vs-param route pair.
  router.post(
    "/evidence-sources/upload-url",
    requireConsent("document_upload_storage"),
    async (req: AuthedRequest, res) => {
      const parsed = UploadUrlRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      }

      const candidateId = await getOwnCandidateId(req);
      if (!candidateId) {
        return res.status(404).json({ error: "candidate_not_found" });
      }

      const path = buildUploadPath(candidateId, parsed.data.filename);
      const supabase = req.supabase!;
      const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUploadUrl(path);

      if (error || !data) {
        return res.status(400).json({ error: "upload_url_creation_failed", message: error?.message });
      }

      // path is what the client should send back as file_ref on the
      // subsequent POST /evidence-sources call, once the upload completes.
      return res.status(201).json({
        path: data.path,
        signed_url: data.signedUrl,
        token: data.token,
      });
    }
  );

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
    const { data: evidence, error: fetchError } = await supabase
      .from("evidence_source")
      .select("source_type, file_ref")
      .eq("id", idParsed.data)
      .maybeSingle();

    if (fetchError) {
      return res.status(400).json({ error: "evidence_source_fetch_failed", message: fetchError.message });
    }
    if (!evidence) {
      return res.status(404).json({ error: "evidence_source_not_found" });
    }
    if (evidence.source_type !== "document_upload" || !evidence.file_ref) {
      // github_repository evidence already has a usable external_url on
      // the record itself — no signed URL needed, so this isn't a valid
      // request for that source_type rather than a silent no-op.
      return res.status(400).json({ error: "not_a_document_upload" });
    }

    const { data: signed, error: signError } = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .createSignedUrl(evidence.file_ref, DOWNLOAD_URL_TTL_SECONDS);

    if (signError || !signed) {
      return res.status(400).json({ error: "download_url_creation_failed", message: signError?.message });
    }

    return res.status(200).json({ download_url: signed.signedUrl, expires_in: DOWNLOAD_URL_TTL_SECONDS });
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

    // Gate 1a: for document_upload, file_ref must point at something that
    // (a) actually exists in Storage and (b) is under the caller's own
    // candidate_id prefix — same write-time-validate-the-reference
    // discipline as claim.ts's subject_entity_id check (Gate 0).
    // github_repository's external_url has no equivalent existence check —
    // it's just a URL the candidate is asserting, same as before.
    if (parsed.data.source_type === "document_upload") {
      const valid = await fileRefIsValid(req, candidateId, parsed.data.file_ref!);
      if (!valid) {
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

    // Same file_ref validation as POST — PUT is a full replace using the
    // same schema, so it's an equally valid path to smuggle in a dangling
    // or foreign file_ref if left unchecked here.
    if (parsed.data.source_type === "document_upload") {
      const candidateId = await getOwnCandidateId(req);
      if (!candidateId) {
        return res.status(404).json({ error: "candidate_not_found" });
      }
      const valid = await fileRefIsValid(req, candidateId, parsed.data.file_ref!);
      if (!valid) {
        return res.status(400).json({ error: "file_ref_not_found" });
      }
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

    // Delete the DB row first — that's what RLS actually protects, and
    // it's the authoritative "does this evidence source still exist"
    // answer. file_ref is captured via .select() on the same delete call
    // rather than a separate SELECT beforehand, so there's no window where
    // a concurrent request could see a row that's about to disappear.
    const { data, error } = await supabase
      .from("evidence_source")
      .delete()
      .eq("id", idParsed.data)
      .select("id, source_type, file_ref")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "evidence_source_delete_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "evidence_source_not_found" });
    }

    // Best-effort Storage purge, same tolerance as account.ts's philosophy
    // for this exact kind of cleanup: the row is already gone (the
    // ownership/access guarantee is satisfied), so a Storage hiccup here
    // shouldn't turn into a failed DELETE response — it should just be
    // visible in the logs. An orphaned Storage object left behind by a
    // failure here is a cleanup concern, not a security one (RLS still
    // scopes it to this candidate; it's just unreferenced by any row now).
    if (data.source_type === "document_upload" && data.file_ref) {
      const { error: storageError } = await supabase.storage.from(EVIDENCE_BUCKET).remove([data.file_ref]);
      if (storageError) {
        console.warn(`evidence-source.ts: failed to purge Storage object ${data.file_ref}: ${storageError.message}`);
      }
    }

    return res.status(204).send();
  });

  return router;
}
