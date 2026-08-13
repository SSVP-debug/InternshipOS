// experience.ts
// GET    /experiences      — list the caller's own experience records
// GET    /experiences/:id  — get one of the caller's own experience records
// POST   /experiences      — create an experience record for the caller
// PUT    /experiences/:id  — update one of the caller's own experience records
// DELETE /experiences/:id  — delete one of the caller's own experience records
//
// Same pattern as education.ts/skill.ts/project.ts: every query runs
// through req.supabase (the caller's own JWT), so Postgres RLS — not this
// code — is what prevents reading/writing another candidate's experience
// records. Deletion is "safe" the same way: RLS-scoped delete, 404 (not a
// silent no-op or another candidate's row) when the id doesn't resolve to
// one of the caller's own rows. No Claim/EvidenceSource entities exist yet,
// so there is no cascade/orphan concern to handle beyond that.

import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { ExperienceRequestSchema, UuidParamSchema } from "../lib/schemas.js";

const EXPERIENCE_COLUMNS =
  "id, organization, title, employment_type, start_date, end_date, " +
  "is_current, location, description_raw, created_at, updated_at";

async function getOwnCandidateId(req: AuthedRequest): Promise<string | null> {
  const { data, error } = await req.supabase!.from("candidate").select("id").single();
  if (error || !data) return null;
  return data.id as string;
}

export function experienceRouter(): Router {
  const router = Router();

  router.get("/experiences", async (req: AuthedRequest, res) => {
    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("experience")
      .select(EXPERIENCE_COLUMNS)
      .order("start_date", { ascending: false });

    if (error) {
      return res.status(400).json({ error: "experience_fetch_failed", message: error.message });
    }
    return res.status(200).json({ experiences: data });
  });

  router.get("/experiences/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("experience")
      .select(EXPERIENCE_COLUMNS)
      .eq("id", idParsed.data)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "experience_fetch_failed", message: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: "experience_not_found" });
    }
    return res.status(200).json({ experience: data });
  });

  router.post("/experiences", async (req: AuthedRequest, res) => {
    const parsed = ExperienceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const candidateId = await getOwnCandidateId(req);
    if (!candidateId) {
      return res.status(404).json({ error: "candidate_not_found" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("experience")
      .insert({ candidate_id: candidateId, ...parsed.data })
      .select(EXPERIENCE_COLUMNS)
      .single();

    if (error) {
      return res.status(400).json({ error: "experience_create_failed", message: error.message });
    }

    return res.status(201).json({ experience: data });
  });

  router.put("/experiences/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }
    const parsed = ExperienceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("experience")
      .update(parsed.data)
      .eq("id", idParsed.data)
      .select(EXPERIENCE_COLUMNS)
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "experience_update_failed", message: error.message });
    }
    // RLS makes a cross-candidate update a no-op (0 rows), which surfaces
    // identically to "id doesn't exist" — no information leak either way.
    if (!data) {
      return res.status(404).json({ error: "experience_not_found" });
    }
    return res.status(200).json({ experience: data });
  });

  router.delete("/experiences/:id", async (req: AuthedRequest, res) => {
    const idParsed = UuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      return res.status(400).json({ error: "invalid_id" });
    }

    const supabase = req.supabase!;
    const { data, error } = await supabase
      .from("experience")
      .delete()
      .eq("id", idParsed.data)
      .select("id")
      .maybeSingle();

    if (error) {
      return res.status(400).json({ error: "experience_delete_failed", message: error.message });
    }
    // Safe deletion: RLS guarantees a foreign id (or another candidate's
    // row) never actually deletes anything and is reported as not-found.
    if (!data) {
      return res.status(404).json({ error: "experience_not_found" });
    }
    return res.status(204).send();
  });

  return router;
}
