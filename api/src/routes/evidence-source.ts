// evidence-source.ts
// GET    /evidence-sources      — list the caller's own evidence sources
// GET    /evidence-sources/:id  — get one of the caller's own evidence sources
// POST   /evidence-sources      — create an evidence source for the caller
// PUT    /evidence-sources/:id  — update one of the caller's own evidence sources
// DELETE /evidence-sources/:id  — delete one of the caller's own evidence sources
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

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { EvidenceSourceRequestSchema, UuidParamSchema } from "../lib/schemas.js";

const EVIDENCE_SOURCE_COLUMNS =
  "id, source_type, title, file_ref, external_url, owner_verified, created_at, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
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

  router.post("/evidence-sources", async (req: AuthedRequest, res) => {
    const parsed = EvidenceSourceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
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
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "evidence_source_delete_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "evidence_source_not_found" });
    }
    return res.status(204).send();
  });

  return router;
}
