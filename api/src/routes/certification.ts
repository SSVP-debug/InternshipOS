// certification.ts
// GET    /certifications      — list the caller's own certifications
// GET    /certifications/:id  — get one of the caller's own certifications
// POST   /certifications      — create a certification for the caller
// PUT    /certifications/:id  — update one of the caller's own certifications
// DELETE /certifications/:id  — delete one of the caller's own certifications
//
// Same pattern as education.ts/skill.ts/project.ts/experience.ts/achievement.ts:
// every query runs through req.supabase (the caller's own JWT), so Postgres
// RLS — not this code — is what prevents reading/writing another
// candidate's certifications. Deletion is "safe" the same established way:
// RLS-scoped delete, 404 (not a silent no-op or another candidate's row)
// when the id doesn't resolve to one of the caller's own rows.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { CertificationRequestSchema, UuidParamSchema } from "../lib/schemas.js";

const CERTIFICATION_COLUMNS =
  "id, name, issuer, issue_date, expiry_date, credential_id, verification_url, created_at, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export function certificationRouter(): Router {
  const router = Router();

  router.get("/certifications", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("certification")
      .select(CERTIFICATION_COLUMNS)
      .order("issue_date", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "certification_fetch_failed", message: error.message });
    }
    return res.status(200).json({ certifications: data });
  });

  router.get("/certifications/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("certification")
      .select(CERTIFICATION_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "certification_fetch_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "certification_not_found" });
    }
    return res.status(200).json({ certification: data });
  });

  router.post("/certifications", async (req: AuthedRequest, res) => {
    const parsed = CertificationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("certification")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(CERTIFICATION_COLUMNS)
      .single();

    if (error) {
      return res.status(400).json({ error: "certification_create_failed", message: error.message });
    }

    return res.status(201).json({ certification: data });
  });

  router.put("/certifications/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = CertificationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("certification")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .select(CERTIFICATION_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "certification_update_failed", message: error.message });
    }
    // RLS makes a cross-candidate update a no-op (0 rows), which surfaces
    // identically to "id doesn't exist" — no information leak either way.
    if (!data) {
      return res.status(404).json({ error: "certification_not_found" });
    }
    return res.status(200).json({ certification: data });
  });

  router.delete("/certifications/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("certification")
      .delete()
      .eq("id", idParsed.data)
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "certification_delete_failed", message: error.message });
    }
    // Safe deletion: RLS guarantees a foreign id (or another candidate's
    // row) never actually deletes anything and is reported as not-found.
    if (!data) {
      return res.status(404).json({ error: "certification_not_found" });
    }
    return res.status(204).send();
  });

  return router;
}
